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
CONFIG_PATH = MATERIALS_DIR / "星火SoarkUltra-APIkey.txt"
KB_DIR = ROOT_DIR / "data" / "knowledge_base"
OUTPUT_DIR = ROOT_DIR / "outputs"
USERS_DIR = ROOT_DIR / "data" / "users"

app = Flask(__name__, template_folder=str(TEMPLATE_DIR), static_folder=str(STATIC_DIR))
app.secret_key = os.getenv("APP_SECRET_KEY", "software-cup-spark-secret")
user_store = UserStore(str(USERS_DIR))


def create_system(model: str = "4.0Ultra") -> MultiAgentLearningSystem:
    client = SparkClient(config_path=str(CONFIG_PATH), model=model)
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
        output_path = system.save_report(report, run_name)
        user_store.save_run(
            username=username,
            run_name=run_name,
            request_payload=payload,
            report=report,
            output_dir=str(output_path),
        )
    except (FileNotFoundError, ValueError, RuntimeError, RequestException) as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify(
        {
            "run_name": run_name,
            "output_dir": str(output_path),
            "report": report,
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
    if not isinstance(profile, dict):
        return jsonify({"error": "profile 必须是对象类型"}), 400
    if not question or not topic:
        return jsonify({"error": "question、topic 为必填项"}), 400

    try:
        system = create_system(model=model)
        answer = system.tutor(question=question, profile=profile, topic=topic)
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
        }
    )


@app.get("/api/user/run/<run_name>")
def user_run(run_name: str):
    username, err = require_login_json()
    if err:
        return err

    payload = user_store.get_run(username, run_name)
    if payload is None:
        return jsonify({"error": "未找到该历史记录"}), 404
    return jsonify(payload)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
