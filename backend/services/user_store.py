import json
import re
import shutil
import base64
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Tuple

from werkzeug.security import check_password_hash, generate_password_hash


def _utc_now() -> str:
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


class UserStore:
    def __init__(self, base_dir: str, legacy_dir: str | None = None):
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.legacy_dir = Path(legacy_dir) if legacy_dir else None

    def _normalize_username(self, username: str) -> str:
        normalized = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fa5]", "_", username).strip("_")
        if not normalized:
            raise ValueError("用户名不合法")
        return normalized[:48]

    def _user_dir(self, username: str) -> Path:
        return self.base_dir / self._normalize_username(username)

    def _legacy_user_dir(self, username: str) -> Path | None:
        if not self.legacy_dir:
            return None
        return self.legacy_dir / self._normalize_username(username)

    def _ensure_user_migrated(self, username: str):
        user_dir = self._user_dir(username)
        if user_dir.exists():
            return
        legacy_user_dir = self._legacy_user_dir(username)
        if not legacy_user_dir or not legacy_user_dir.exists():
            return
        user_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(legacy_user_dir, user_dir)

    def _user_file(self, username: str) -> Path:
        return self._user_dir(username) / "user.json"

    def _history_file(self, username: str) -> Path:
        return self._user_dir(username) / "history.json"

    def _latest_file(self, username: str) -> Path:
        return self._user_dir(username) / "latest_report.json"

    def _tutor_file(self, username: str) -> Path:
        return self._user_dir(username) / "tutor_log.json"

    def _run_file(self, username: str, run_name: str) -> Path:
        return self._user_dir(username) / "runs" / f"{run_name}.json"

    def _progress_file(self, username: str) -> Path:
        return self._user_dir(username) / "progress_log.json"

    def _avatar_file(self, username: str) -> Path | None:
        user = self._read_json(self._user_file(username), {})
        avatar_file = str(user.get("avatar_file", "")).strip()
        if not avatar_file:
            return None
        path = self._user_dir(username) / avatar_file
        if not path.exists():
            return None
        return path

    def _read_json(self, path: Path, default: Any) -> Any:
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))

    def _write_json(self, path: Path, content: Any):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")

    def _validate_password(self, password: str):
        if len(password) < 6:
            raise ValueError("密码长度至少为6位")

    def _normalize_security_qa(self, questions: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        if len(questions) != 3:
            raise ValueError("必须设置3个密保问题")
        normalized: List[Dict[str, str]] = []
        for idx, item in enumerate(questions, start=1):
            if not isinstance(item, dict):
                raise ValueError(f"第{idx}个密保问题格式错误")
            question = str(item.get("question", "")).strip()
            answer = str(item.get("answer", "")).strip()
            if not question or not answer:
                raise ValueError(f"第{idx}个密保问题和答案不能为空")
            normalized.append(
                {
                    "question": question[:80],
                    "answer_hash": generate_password_hash(answer),
                }
            )
        return normalized

    def _extract_security_questions(self, user: Dict[str, Any]) -> List[Dict[str, str]]:
        stored = user.get("security_questions", [])
        if not isinstance(stored, list):
            return []
        result: List[Dict[str, str]] = []
        for item in stored:
            if not isinstance(item, dict):
                continue
            question = str(item.get("question", "")).strip()
            answer_hash = str(item.get("answer_hash", "")).strip()
            if not question or not answer_hash:
                continue
            result.append({"question": question, "answer_hash": answer_hash})
        return result

    def login_or_register(self, username: str, password: str) -> Tuple[bool, bool]:
        self._ensure_user_migrated(username)
        user_file = self._user_file(username)
        if not user_file.exists():
            self._validate_password(password)
            payload = {
                "username": username,
                "password_hash": generate_password_hash(password),
                "security_questions": [],
                "created_at": _utc_now(),
                "updated_at": _utc_now(),
            }
            self._write_json(user_file, payload)
            return True, True

        user = self._read_json(user_file, {})
        ok = check_password_hash(user.get("password_hash", ""), password)
        return ok, False

    def save_run(
        self,
        username: str,
        run_name: str,
        request_payload: Dict[str, Any],
        report: Dict[str, Any],
        output_dir: str,
        report_markdown: Dict[str, str] | None = None,
    ):
        self._ensure_user_migrated(username)
        created_at = _utc_now()
        run_payload = {
            "run_name": run_name,
            "created_at": created_at,
            "request": request_payload,
            "output_dir": output_dir,
            "report": report,
            "report_markdown": report_markdown or {},
        }
        self._write_json(self._run_file(username, run_name), run_payload)
        self._write_json(self._latest_file(username), {"run_name": run_name, "updated_at": created_at})

        history = self._read_json(self._history_file(username), [])
        history.insert(
            0,
            {
                "run_name": run_name,
                "created_at": created_at,
                "course": request_payload.get("course", ""),
                "topic": request_payload.get("topic", ""),
                "output_dir": output_dir,
            },
        )
        self._write_json(self._history_file(username), history[:100])

    def _resolve_latest_run_name(self, username: str) -> str:
        payload = self._read_json(self._latest_file(username), None)
        if not isinstance(payload, dict):
            return ""
        run_name = str(payload.get("run_name", "")).strip()
        if run_name:
            return run_name
        # 兼容旧格式（latest_report.json 内直接存完整 run_payload）
        legacy_run_name = str(payload.get("run_name", "")).strip()
        return legacy_run_name

    def list_runs(self, username: str) -> List[Dict[str, Any]]:
        self._ensure_user_migrated(username)
        return self._read_json(self._history_file(username), [])

    def get_run(self, username: str, run_name: str) -> Dict[str, Any] | None:
        self._ensure_user_migrated(username)
        path = self._run_file(username, run_name)
        if not path.exists():
            return None
        return self._read_json(path, None)

    def get_latest_report(self, username: str) -> Dict[str, Any] | None:
        self._ensure_user_migrated(username)
        latest_payload = self._read_json(self._latest_file(username), None)
        if not isinstance(latest_payload, dict):
            return None
        # 兼容旧格式：latest_report.json 直接存完整 run_payload
        if "report" in latest_payload and "request" in latest_payload:
            run_name = str(latest_payload.get("run_name", "")).strip()
            if run_name:
                self._write_json(self._latest_file(username), {"run_name": run_name, "updated_at": _utc_now()})
            return latest_payload
        run_name = str(latest_payload.get("run_name", "")).strip()
        if not run_name:
            return None
        return self.get_run(username, run_name)

    def has_latest_report(self, username: str) -> bool:
        return self.get_latest_report(username) is not None

    def update_latest_report(self, username: str, payload: Dict[str, Any]):
        self._ensure_user_migrated(username)
        run_name = str(payload.get("run_name", "")).strip()
        if not run_name:
            raise ValueError("更新 latest_report 失败：payload 缺少 run_name")
        self._write_json(self._run_file(username, run_name), payload)
        self._write_json(self._latest_file(username), {"run_name": run_name, "updated_at": _utc_now()})

    def update_run(self, username: str, run_name: str, payload: Dict[str, Any]):
        self._ensure_user_migrated(username)
        self._write_json(self._run_file(username, run_name), payload)

    def delete_run(self, username: str, run_name: str) -> bool:
        self._ensure_user_migrated(username)
        run_path = self._run_file(username, run_name)
        if not run_path.exists():
            return False

        run_path.unlink()

        history = self._read_json(self._history_file(username), [])
        new_history = [item for item in history if str(item.get("run_name", "")).strip() != run_name]
        self._write_json(self._history_file(username), new_history)

        progress_logs = self._read_json(self._progress_file(username), [])
        filtered_logs = [item for item in progress_logs if str(item.get("run_name", "")).strip() != run_name]
        self._write_json(self._progress_file(username), filtered_logs)

        latest_path = self._latest_file(username)
        latest_run_name = self._resolve_latest_run_name(username)

        if latest_run_name == run_name:
            next_run_name = ""
            if new_history:
                next_run_name = str(new_history[0].get("run_name", "")).strip()
            next_payload = self.get_run(username, next_run_name) if next_run_name else None
            if isinstance(next_payload, dict):
                self._write_json(latest_path, {"run_name": next_run_name, "updated_at": _utc_now()})
            elif latest_path.exists():
                latest_path.unlink()

        return True

    def append_progress_log(self, username: str, entry: Dict[str, Any]):
        self._ensure_user_migrated(username)
        logs = self._read_json(self._progress_file(username), [])
        logs.insert(0, entry)
        self._write_json(self._progress_file(username), logs[:500])

    def get_progress_logs(self, username: str, limit: int = 30) -> List[Dict[str, Any]]:
        self._ensure_user_migrated(username)
        logs = self._read_json(self._progress_file(username), [])
        return logs[: max(1, limit)]

    def save_tutor(self, username: str, question: str, answer: str, topic: str):
        self._ensure_user_migrated(username)
        logs = self._read_json(self._tutor_file(username), [])
        logs.insert(
            0,
            {"created_at": _utc_now(), "topic": topic, "question": question, "answer": answer},
        )
        self._write_json(self._tutor_file(username), logs[:200])

    def get_user_center(self, username: str) -> Dict[str, Any]:
        self._ensure_user_migrated(username)
        user = self._read_json(self._user_file(username), {})
        history = self._read_json(self._history_file(username), [])
        latest = self._read_json(self._latest_file(username), {})
        security_questions = self._extract_security_questions(user)
        latest_run_name = ""
        if isinstance(latest, dict):
            latest_run_name = str(latest.get("run_name", "")).strip()
        project_names: List[str] = []
        if isinstance(history, list):
            for item in history:
                if not isinstance(item, dict):
                    continue
                course = str(item.get("course", "")).strip()
                topic = str(item.get("topic", "")).strip()
                run_name = str(item.get("run_name", "")).strip()
                name = " · ".join([part for part in [course, topic] if part]) or run_name
                if name:
                    project_names.append(name)
        avatar_file = str(user.get("avatar_file", "")).strip()
        return {
            "username": user.get("username", username),
            "created_at": user.get("created_at", ""),
            "updated_at": user.get("updated_at", ""),
            "project_count": len(history) if isinstance(history, list) else 0,
            "project_names": project_names[:100],
            "latest_run_name": latest_run_name,
            "has_security_questions": len(security_questions) == 3,
            "security_questions": [{"question": item["question"]} for item in security_questions],
            "has_avatar": bool(avatar_file),
            "avatar_updated_at": user.get("avatar_updated_at", ""),
        }

    def get_security_questions(self, username: str) -> List[str]:
        self._ensure_user_migrated(username)
        user = self._read_json(self._user_file(username), None)
        if not isinstance(user, dict):
            raise ValueError("用户不存在")
        security_questions = self._extract_security_questions(user)
        if len(security_questions) != 3:
            raise ValueError("该账号尚未设置密保问题")
        return [item["question"] for item in security_questions]

    def set_security_questions(
        self,
        username: str,
        current_password: str,
        questions: List[Dict[str, Any]],
    ):
        self._ensure_user_migrated(username)
        user_file = self._user_file(username)
        user = self._read_json(user_file, None)
        if not isinstance(user, dict):
            raise ValueError("用户不存在")
        if not check_password_hash(user.get("password_hash", ""), current_password):
            raise ValueError("当前密码错误")
        user["security_questions"] = self._normalize_security_qa(questions)
        user["updated_at"] = _utc_now()
        self._write_json(user_file, user)

    def reset_password_by_security_questions(
        self,
        username: str,
        answers: List[str],
        new_password: str,
    ):
        self._validate_password(new_password)
        self._ensure_user_migrated(username)
        user_file = self._user_file(username)
        user = self._read_json(user_file, None)
        if not isinstance(user, dict):
            raise ValueError("用户不存在")
        security_questions = self._extract_security_questions(user)
        if len(security_questions) != 3:
            raise ValueError("该账号尚未设置密保问题")
        if len(answers) != 3:
            raise ValueError("必须回答3个密保问题")
        for idx, item in enumerate(security_questions):
            answer = str(answers[idx] if idx < len(answers) else "").strip()
            if not check_password_hash(item["answer_hash"], answer):
                raise ValueError("密保答案错误")
        user["password_hash"] = generate_password_hash(new_password)
        user["updated_at"] = _utc_now()
        self._write_json(user_file, user)

    def change_password(self, username: str, current_password: str, new_password: str):
        self._validate_password(new_password)
        self._ensure_user_migrated(username)
        user_file = self._user_file(username)
        user = self._read_json(user_file, None)
        if not isinstance(user, dict):
            raise ValueError("用户不存在")
        if not check_password_hash(user.get("password_hash", ""), current_password):
            raise ValueError("当前密码错误")
        user["password_hash"] = generate_password_hash(new_password)
        user["updated_at"] = _utc_now()
        self._write_json(user_file, user)

    def save_avatar(self, username: str, avatar_data_url: str):
        self._ensure_user_migrated(username)
        match = re.match(r"^data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$", str(avatar_data_url).strip())
        if not match:
            raise ValueError("头像格式不合法，仅支持 png/jpg/webp")
        ext = match.group(1).lower()
        if ext == "jpeg":
            ext = "jpg"
        try:
            raw = base64.b64decode(match.group(2), validate=True)
        except ValueError as exc:
            raise ValueError("头像数据解析失败") from exc
        if not raw:
            raise ValueError("头像数据不能为空")
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("头像文件不能超过2MB")

        user_dir = self._user_dir(username)
        for old in user_dir.glob("avatar.*"):
            if old.is_file():
                old.unlink()
        avatar_name = f"avatar.{ext}"
        avatar_path = user_dir / avatar_name
        avatar_path.write_bytes(raw)

        user_file = self._user_file(username)
        user = self._read_json(user_file, None)
        if not isinstance(user, dict):
            raise ValueError("用户不存在")
        user["avatar_file"] = avatar_name
        user["avatar_updated_at"] = _utc_now()
        user["updated_at"] = _utc_now()
        self._write_json(user_file, user)

    def get_avatar(self, username: str) -> Path | None:
        self._ensure_user_migrated(username)
        return self._avatar_file(username)
