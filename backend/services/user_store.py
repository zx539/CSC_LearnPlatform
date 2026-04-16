import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Tuple

from werkzeug.security import check_password_hash, generate_password_hash


def _utc_now() -> str:
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


class UserStore:
    def __init__(self, base_dir: str):
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _normalize_username(self, username: str) -> str:
        normalized = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fa5]", "_", username).strip("_")
        if not normalized:
            raise ValueError("用户名不合法")
        return normalized[:48]

    def _user_dir(self, username: str) -> Path:
        return self.base_dir / self._normalize_username(username)

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

    def _read_json(self, path: Path, default: Any) -> Any:
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))

    def _write_json(self, path: Path, content: Any):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")

    def login_or_register(self, username: str, password: str) -> Tuple[bool, bool]:
        user_file = self._user_file(username)
        if not user_file.exists():
            payload = {
                "username": username,
                "password_hash": generate_password_hash(password),
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
        return self._read_json(self._history_file(username), [])

    def get_run(self, username: str, run_name: str) -> Dict[str, Any] | None:
        path = self._run_file(username, run_name)
        if not path.exists():
            return None
        return self._read_json(path, None)

    def get_latest_report(self, username: str) -> Dict[str, Any] | None:
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
        run_name = str(payload.get("run_name", "")).strip()
        if not run_name:
            raise ValueError("更新 latest_report 失败：payload 缺少 run_name")
        self._write_json(self._run_file(username, run_name), payload)
        self._write_json(self._latest_file(username), {"run_name": run_name, "updated_at": _utc_now()})

    def update_run(self, username: str, run_name: str, payload: Dict[str, Any]):
        self._write_json(self._run_file(username, run_name), payload)

    def delete_run(self, username: str, run_name: str) -> bool:
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
        logs = self._read_json(self._progress_file(username), [])
        logs.insert(0, entry)
        self._write_json(self._progress_file(username), logs[:500])

    def get_progress_logs(self, username: str, limit: int = 30) -> List[Dict[str, Any]]:
        logs = self._read_json(self._progress_file(username), [])
        return logs[: max(1, limit)]

    def save_tutor(self, username: str, question: str, answer: str, topic: str):
        logs = self._read_json(self._tutor_file(username), [])
        logs.insert(
            0,
            {"created_at": _utc_now(), "topic": topic, "question": question, "answer": answer},
        )
        self._write_json(self._tutor_file(username), logs[:200])
