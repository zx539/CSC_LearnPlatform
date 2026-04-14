from datetime import datetime
import os
from pathlib import Path

from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from requests import RequestException

from backend.services.multi_agent import MultiAgentLearningSystem
from backend.services.spark_client import SparkClient
from backend.services.user_store import UserStore


ROOT_DIR = Path(__file__).resolve().parents[1]
TEMPLATE_DIR = ROOT_DIR / "frontend" / "templates"
STATIC_DIR = ROOT_DIR / "frontend" / "static"
MATERIALS_DIR = ROOT_DIR / "materials"
ULTRA_CONFIG_PATH = MATERIALS_DIR / "星火SoarkUltra-APIkey.txt"
LITE_CONFIG_PATH = MATERIALS_DIR / "星火SparkLite-APIkey.txt"
KB_DIR = ROOT_DIR / "data" / "knowledge_base"
OUTPUT_DIR = ROOT_DIR / "outputs"
USERS_DIR = ROOT_DIR / "data" / "users"

app = Flask(__name__, template_folder=str(TEMPLATE_DIR), static_folder=str(STATIC_DIR))
app.secret_key = os.getenv("APP_SECRET_KEY", "software-cup-spark-secret")
user_store = UserStore(str(USERS_DIR))


def normalize_model(model: str) -> str:
    normalized = str(model or "").strip().lower()
    if normalized in {"lite", "sparklite", "4.0lite"}:
        return "lite"
    return "4.0Ultra"


def resolve_model_config_path(model: str) -> Path:
    normalized = normalize_model(model)
    if normalized == "lite":
        return LITE_CONFIG_PATH
    return ULTRA_CONFIG_PATH


def create_system(model: str = "4.0Ultra") -> MultiAgentLearningSystem:
    normalized_model = normalize_model(model)
    config_path = resolve_model_config_path(normalized_model)
    client = SparkClient(config_path=str(config_path), model=normalized_model)
    return MultiAgentLearningSystem(spark=client, kb_dir=str(KB_DIR), output_dir=str(OUTPUT_DIR))


def get_login_user() -> str | None:
    username = session.get("username")
    if isinstance(username, str) and username:
        return username
    return None


def require_login_json():
    user = get_login_user()
    if not user:
        return None, (jsonify({"error": "请先登录"}), 401)
    return user, None


@app.get("/login")
def login_page():
    if get_login_user():
        return redirect(url_for("index"))
    return render_template("login.html")


@app.post("/login")
def login_action():
    username = str(request.form.get("username", "")).strip()
    password = str(request.form.get("password", "")).strip()
    if not username or not password:
        return render_template("login.html", error="用户名和密码不能为空")

    try:
        ok, created = user_store.login_or_register(username, password)
    except ValueError as exc:
        return render_template("login.html", error=str(exc))
    if not ok:
        return render_template("login.html", error="用户名或密码错误")

    session["username"] = username
    session["progress_submitted_this_login"] = False
    if created:
        return redirect(url_for("index", notice="首次登录已创建账号"))
    return redirect(url_for("index"))


@app.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("login_page"))


@app.get("/")
def index():
    username = get_login_user()
    if not username:
        return redirect(url_for("login_page"))
    return render_template("index.html", username=username, notice=request.args.get("notice", ""))


@app.post("/api/generate")
def generate():
    username, err = require_login_json()
    if err:
        return err

    payload = request.get_json(silent=True)
    if payload is None:
        return jsonify({"error": "请求体必须是JSON"}), 400

    course = str(payload.get("course", "")).strip()
    topic = str(payload.get("topic", "")).strip()
    dialogue = str(payload.get("dialogue", "")).strip()
    progress = str(payload.get("progress", "")).strip()
    model = str(payload.get("model", "4.0Ultra")).strip() or "4.0Ultra"

    if not course or not topic or not dialogue:
        return jsonify({"error": "course、topic、dialogue 为必填项"}), 400

    run_name = datetime.now().strftime("run_%Y%m%d_%H%M%S")
    try:
        system = create_system(model=model)
        report = system.run(dialogue=dialogue, course=course, topic=topic, progress=progress)
        output_path, report_markdown = system.save_report(report, run_name)
        user_store.save_run(
            username=username,
            run_name=run_name,
            request_payload=payload,
            report=report,
            output_dir=str(output_path),
            report_markdown=report_markdown,
        )
    except (FileNotFoundError, ValueError, RuntimeError, RequestException) as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify(
        {
            "run_name": run_name,
            "output_dir": str(output_path),
            "report": report,
            "report_markdown": report_markdown,
        }
    )


@app.post("/api/tutor")
def tutor():
    username, err = require_login_json()
    if err:
        return err

    payload = request.get_json(silent=True)
    if payload is None:
        return jsonify({"error": "请求体必须是JSON"}), 400

    question = str(payload.get("question", "")).strip()
    topic = str(payload.get("topic", "")).strip()
    model = str(payload.get("model", "4.0Ultra")).strip() or "4.0Ultra"
    profile = payload.get("profile")
    memory_payload = payload.get("memory", [])
    if not isinstance(profile, dict):
        return jsonify({"error": "profile 必须是对象类型"}), 400
    if not isinstance(memory_payload, list):
        return jsonify({"error": "memory 必须是数组类型"}), 400
    memory: list[dict[str, str]] = []
    for item in memory_payload[:20]:
        if not isinstance(item, dict):
            continue
        q = str(item.get("question", "")).strip()
        a = str(item.get("answer", "")).strip()
        if not q and not a:
            continue
        memory.append({"question": q, "answer": a})
    if not question or not topic:
        return jsonify({"error": "question、topic 为必填项"}), 400

    try:
        system = create_system(model=model)
        answer = system.tutor(question=question, profile=profile, topic=topic, memory=memory)
        user_store.save_tutor(username=username, question=question, answer=answer, topic=topic)
    except (FileNotFoundError, ValueError, RuntimeError, RequestException) as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify({"answer": answer})


@app.get("/api/user/profile")
def user_profile():
    username, err = require_login_json()
    if err:
        return err

    return jsonify(
        {
            "username": username,
            "runs": user_store.list_runs(username),
            "latest": user_store.get_latest_report(username),
            "progress_logs": user_store.get_progress_logs(username, limit=10),
        }
    )


@app.get("/api/projects")
def list_projects():
    username, err = require_login_json()
    if err:
        return err

    return jsonify({"projects": user_store.list_runs(username)})


@app.get("/api/user/run/<run_name>")
def user_run(run_name: str):
    username, err = require_login_json()
    if err:
        return err

    payload = user_store.get_run(username, run_name)
    if payload is None:
        return jsonify({"error": "未找到该历史记录"}), 404
    return jsonify(payload)


@app.delete("/api/user/run/<run_name>")
def delete_user_run(run_name: str):
    username, err = require_login_json()
    if err:
        return err

    ok = user_store.delete_run(username, run_name)
    if not ok:
        return jsonify({"error": "未找到该历史记录"}), 404

    return jsonify({"message": "历史记录已删除", "run_name": run_name})


@app.post("/api/progress/checkin")
def progress_checkin():
    username, err = require_login_json()
    if err:
        return err

    payload = request.get_json(silent=True)
    if payload is None:
        return jsonify({"error": "请求体必须是JSON"}), 400
    checkin = payload.get("checkin")
    if not isinstance(checkin, dict):
        return jsonify({"error": "checkin 必须是对象类型"}), 400
    form_type = str(payload.get("form_type", "progress")).strip().lower() or "progress"
    if form_type not in {"progress", "test"}:
        return jsonify({"error": "form_type 仅支持 progress 或 test"}), 400
    responses = checkin.get("responses")
    if not isinstance(responses, list) or not responses:
        return jsonify({"error": "问卷答案不能为空，请先完成问卷填写"}), 400

    run_name = str(payload.get("run_name", "")).strip()
    latest = user_store.get_latest_report(username)
    target_payload = None
    if run_name:
        target_payload = user_store.get_run(username, run_name)
    elif isinstance(latest, dict):
        target_payload = latest

    if not isinstance(target_payload, dict):
        return jsonify({"error": "未找到对应学习项目，请先选择已有项目"}), 400

    report = target_payload.get("report")
    if not isinstance(report, dict):
        return jsonify({"error": "历史报告格式错误"}), 500

    profile = report.get("profile")
    path = report.get("learning_path")
    if not isinstance(profile, dict) or not isinstance(path, dict):
        return jsonify({"error": "历史报告缺少学习画像或学习路径"}), 500

    req_payload = target_payload.get("request", {})
    default_model = "4.0Ultra"
    if isinstance(req_payload, dict):
        default_model = str(req_payload.get("model", "4.0Ultra")).strip() or "4.0Ultra"
    model = str(payload.get("model", default_model)).strip() or default_model

    system = create_system(model=model)
    try:
        evaluation = system.evaluate_learning(progress_payload=checkin, profile=profile, path=path)
    except (FileNotFoundError, ValueError, RuntimeError, RequestException) as exc:
        return jsonify({"error": str(exc)}), 500
    report["evaluation"] = evaluation
    generated_next_form = False

    questionnaire_history = report.get("questionnaire_history", [])
    if not isinstance(questionnaire_history, list):
        questionnaire_history = []

    if form_type == "test":
        req_topic = ""
        req_data = target_payload.get("request", {})
        if isinstance(req_data, dict):
            req_topic = str(req_data.get("topic", "")).strip()
        topic = req_topic or str(checkin.get("topic", "")).strip()
        current_progress_form = report.get("progress_form_template", {})
        if not isinstance(current_progress_form, dict):
            current_progress_form = {}
        current_test_form = report.get("test_form_template", {})
        if not isinstance(current_test_form, dict):
            current_test_form = {}
        stage_state = report.get("stage_state", {})
        stage_no = 1
        if isinstance(stage_state, dict):
            try:
                stage_no = max(1, int(stage_state.get("current_stage_no", 1)))
            except (TypeError, ValueError):
                stage_no = 1
        try:
            stage_no = max(1, int(current_progress_form.get("stage_no", stage_no)))
        except (TypeError, ValueError):
            stage_no = max(1, stage_no)
        try:
            stage_no = max(1, int(current_test_form.get("stage_no", stage_no)))
        except (TypeError, ValueError):
            stage_no = max(1, stage_no)
        try:
            next_progress_form = system.build_progress_form(
                topic=topic,
                path=path,
                profile=profile,
                stage_no=stage_no,
                last_checkin=checkin,
                last_evaluation=evaluation,
            )
            next_test_form = system.build_test_form(
                topic=topic,
                path=path,
                profile=profile,
                stage_no=stage_no,
                last_checkin=checkin,
                last_evaluation=evaluation,
            )
        except (FileNotFoundError, ValueError, RuntimeError, RequestException) as exc:
            return jsonify({"error": str(exc)}), 500
        report["progress_form_template"] = next_progress_form
        report["test_form_template"] = next_test_form
        generated_next_form = True
        if current_progress_form:
            questionnaire_history.insert(
                0,
                {
                    "form_type": "progress",
                    "stage_no": stage_no,
                    "created_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "version_tag": "old",
                    "form": current_progress_form,
                    "markdown": system._progress_form_to_markdown(current_progress_form),
                },
            )
        questionnaire_history.insert(
            0,
            {
                "form_type": "progress",
                "stage_no": stage_no,
                "created_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
                "version_tag": "new",
                "form": next_progress_form,
                "markdown": system._progress_form_to_markdown(next_progress_form),
            },
        )
        if current_test_form:
            questionnaire_history.insert(
                0,
                {
                    "form_type": "test",
                    "stage_no": stage_no,
                    "created_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "version_tag": "old",
                    "form": current_test_form,
                    "markdown": system._progress_form_to_markdown(current_test_form),
                },
            )
        questionnaire_history.insert(
            0,
            {
                "form_type": "test",
                "stage_no": stage_no,
                "created_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
                "version_tag": "new",
                "form": next_test_form,
                "markdown": system._progress_form_to_markdown(next_test_form),
            },
        )

    report["questionnaire_history"] = questionnaire_history[:200]
    report_markdown = system.build_report_markdown(report)
    target_payload["report"] = report
    target_payload["report_markdown"] = report_markdown
    output_dir = str(target_payload.get("output_dir", "")).strip()
    if output_dir:
        system.persist_markdown_files(Path(output_dir), report_markdown)
        system.persist_questionnaire_markdown_files(Path(output_dir), report.get("questionnaire_history", []))

    progress_entry = {
        "created_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "run_name": target_payload.get("run_name", ""),
        "form_type": form_type,
        "checkin": checkin,
        "evaluation": evaluation,
    }
    latest_checkins = target_payload.get("progress_checkins", [])
    if not isinstance(latest_checkins, list):
        latest_checkins = []
    latest_checkins.insert(0, progress_entry)
    target_payload["progress_checkins"] = latest_checkins[:100]

    target_run_name = str(target_payload.get("run_name", "")).strip()
    if target_run_name:
        user_store.update_run(username, target_run_name, target_payload)
    if isinstance(latest, dict) and str(latest.get("run_name", "")).strip() == target_run_name:
        user_store.update_latest_report(username, target_payload)
    user_store.append_progress_log(username, progress_entry)
    session["progress_submitted_this_login"] = True

    return jsonify(
        {
            "message": "问卷已提交",
            "evaluation": evaluation,
            "evaluation_md": report_markdown.get("evaluation_md", ""),
            "report_markdown": report_markdown,
            "run_name": target_run_name,
            "next_progress_form": report.get("progress_form_template", {}),
            "next_test_form": report.get("test_form_template", {}),
            "generated_next_form": generated_next_form,
            "form_type": form_type,
        }
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
