import json
import os
import random
import time
from threading import Lock, Semaphore
from pathlib import Path
from typing import Dict, List, Tuple

import requests


class SparkClient:
    _semaphore_lock = Lock()
    _model_semaphores: Dict[str, Semaphore] = {}
    _qps_lock = Lock()
    _model_next_allowed_ts: Dict[str, float] = {}

    def __init__(self, config_path: str, model: str = "4.0Ultra", timeout: Tuple[int, int] | None = None):
        self.model = model
        model_key = str(self.model or "").strip().lower()
        connect_timeout = self._resolve_int_env(model_key, "CONNECT_TIMEOUT", "10")
        read_timeout = self._resolve_int_env(model_key, "READ_TIMEOUT", "240")
        self.timeout = timeout or (connect_timeout, read_timeout)
        default_retries = "4" if model_key in {"lite", "sparklite", "4.0lite"} else "2"
        self.max_retries = max(0, self._resolve_int_env(model_key, "MAX_RETRIES", default_retries))
        self.retry_interval = max(0.0, self._resolve_float_env(model_key, "RETRY_INTERVAL", "1.0"))
        default_parallel = "2" if model_key in {"lite", "sparklite", "4.0lite"} else "5"
        self.max_parallel = max(1, self._resolve_int_env(model_key, "MAX_PARALLEL", default_parallel))
        default_qps = "1.0" if model_key in {"lite", "sparklite", "4.0lite"} else "3.0"
        self.max_qps = max(0.1, self._resolve_float_env(model_key, "MAX_QPS", default_qps))
        default_stream = "1" if model_key in {"lite", "sparklite", "4.0lite"} else "0"
        self.enable_stream = self._resolve_int_env(model_key, "STREAM", default_stream) > 0
        self.acquire_timeout = max(1, self._resolve_int_env(model_key, "ACQUIRE_TIMEOUT", "300"))
        self.url, self.authorization = self._load_config(config_path)
        self.session = requests.Session()

    @staticmethod
    def _safe_int(value: str, default: int) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _safe_float(value: str, default: float) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    @classmethod
    def _resolve_int_env(cls, model_key: str, suffix: str, default: str) -> int:
        shared = os.getenv(f"SPARK_{suffix}")
        if model_key in {"doubao", "seed2.0pro", "seed2", "doubao-seed-2-0-pro-260215"}:
            value = os.getenv(f"DOUBAO_{suffix}") or shared or default
        elif model_key in {"lite", "sparklite", "4.0lite"}:
            value = os.getenv(f"SPARK_LITE_{suffix}") or shared or default
        else:
            value = os.getenv(f"SPARK_ULTRA_{suffix}") or shared or default
        return cls._safe_int(value, cls._safe_int(default, 0))

    @classmethod
    def _resolve_float_env(cls, model_key: str, suffix: str, default: str) -> float:
        shared = os.getenv(f"SPARK_{suffix}")
        if model_key in {"doubao", "seed2.0pro", "seed2", "doubao-seed-2-0-pro-260215"}:
            value = os.getenv(f"DOUBAO_{suffix}") or shared or default
        elif model_key in {"lite", "sparklite", "4.0lite"}:
            value = os.getenv(f"SPARK_LITE_{suffix}") or shared or default
        else:
            value = os.getenv(f"SPARK_ULTRA_{suffix}") or shared or default
        return cls._safe_float(value, cls._safe_float(default, 0.0))

    @classmethod
    def _get_model_semaphore(cls, model: str, max_parallel: int) -> Semaphore:
        key = str(model or "").strip().lower() or "default"
        with cls._semaphore_lock:
            sem = cls._model_semaphores.get(key)
            if sem is None:
                sem = Semaphore(max_parallel)
                cls._model_semaphores[key] = sem
            return sem

    @staticmethod
    def _clean_value(raw: str) -> str:
        value = raw.split("：", 1)[-1].strip() if "：" in raw else raw.strip()
        value = value.split(":", 1)[1].strip() if value.lower().startswith("apikey:") else value
        return value

    def _load_config(self, config_path: str) -> Tuple[str, str]:
        model_key = str(self.model or "").strip().lower()
        if model_key in {"lite", "sparklite", "4.0lite"}:
            env_url = os.getenv("SPARK_LITE_API_URL") or os.getenv("SPARK_API_URL")
            env_auth = os.getenv("SPARK_LITE_API_AUTH") or os.getenv("SPARK_API_AUTH")
        elif model_key in {"doubao", "seed2.0pro", "seed2", "doubao-seed-2-0-pro-260215"}:
            env_url = os.getenv("DOUBAO_API_URL")
            env_auth = os.getenv("DOUBAO_API_AUTH") or os.getenv("DOUBAO_API_KEY")
        else:
            env_url = os.getenv("SPARK_ULTRA_API_URL") or os.getenv("SPARK_API_URL")
            env_auth = os.getenv("SPARK_ULTRA_API_AUTH") or os.getenv("SPARK_API_AUTH")
        if env_url and env_auth:
            auth = env_auth if env_auth.lower().startswith("bearer ") else f"Bearer {env_auth}"
            return env_url.strip(), auth.strip()

        path = Path(config_path)
        if not path.exists():
            raise FileNotFoundError(f"未找到配置文件: {config_path}")

        url = ""
        auth = ""
        for line in path.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s:
                continue
            if "接口地址" in s or s.lower().startswith("url"):
                url = self._clean_value(s)
            if "APIkey" in s or "api_key" in s.lower():
                auth = self._clean_value(s)

        if not url or not auth:
            raise ValueError("配置文件缺少接口地址或APIkey")
        if not auth.lower().startswith("bearer "):
            auth = f"Bearer {auth}"
        return url, auth

    def _request_url(self) -> str:
        model_key = str(self.model or "").strip().lower()
        base_url = str(self.url or "").strip().rstrip("/")
        if model_key in {"doubao", "seed2.0pro", "seed2", "doubao-seed-2-0-pro-260215"}:
            if base_url.endswith("/chat/completions") or base_url.endswith("/responses"):
                return base_url
            if base_url.endswith("/api/v3"):
                return f"{base_url}/chat/completions"
        return base_url

    @staticmethod
    def _extract_message_content(message: Dict) -> str:
        content = message.get("content", "")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: List[str] = []
            for item in content:
                if isinstance(item, str):
                    text = item.strip()
                    if text:
                        parts.append(text)
                    continue
                if not isinstance(item, dict):
                    continue
                text = str(item.get("text", "")).strip()
                if text:
                    parts.append(text)
            return "\n".join(parts).strip()
        return ""

    def _extract_content(self, data: Dict) -> str:
        choices = data.get("choices", [])
        if isinstance(choices, list) and choices:
            choice = choices[0] if isinstance(choices[0], dict) else {}
            message = choice.get("message", {})
            if isinstance(message, dict):
                text = self._extract_message_content(message)
                if text:
                    return text
            delta = choice.get("delta", {})
            if isinstance(delta, dict):
                text = self._extract_message_content(delta)
                if text:
                    return text
            # 兼容部分 lite 返回: choices[0].text
            text = str(choice.get("text", "")).strip()
            if text:
                return text
        # 兼容部分结构: output/text
        output = data.get("output", {})
        if isinstance(output, dict):
            output_text = str(output.get("text", "")).strip()
            if output_text:
                return output_text
        return ""

    def _wait_for_qps_slot(self):
        model_key = str(self.model or "").strip().lower() or "default"
        interval = 1.0 / max(self.max_qps, 0.1)
        sleep_seconds = 0.0
        with self._qps_lock:
            now = time.monotonic()
            next_allowed = self._model_next_allowed_ts.get(model_key, now)
            if next_allowed > now:
                sleep_seconds = next_allowed - now
            scheduled_at = max(now, next_allowed) + interval
            self._model_next_allowed_ts[model_key] = scheduled_at
        if sleep_seconds > 0:
            time.sleep(sleep_seconds)

    @staticmethod
    def _is_qps_overflow_response(resp: requests.Response) -> bool:
        if resp.status_code < 400:
            return False
        text = (resp.text or "").strip()
        if "AppIdQpsOverFlowError" in text:
            return True
        try:
            payload = resp.json()
        except ValueError:
            return False
        if not isinstance(payload, dict):
            return False
        err = payload.get("error", {})
        if not isinstance(err, dict):
            return False
        code = str(err.get("code", "")).strip()
        message = str(err.get("message", "")).strip()
        return code == "11202" or "AppIdQpsOverFlowError" in message

    def _read_stream_content(self, resp: requests.Response) -> str:
        chunks: List[str] = []
        for raw_line in resp.iter_lines(decode_unicode=True):
            if raw_line is None:
                continue
            line = str(raw_line).strip()
            if not line:
                continue
            if line.startswith("data:"):
                line = line[5:].strip()
            if line == "[DONE]":
                break
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            text = self._extract_content(payload)
            if text:
                chunks.append(text)
        return "".join(chunks).strip()

    def chat(self, messages: List[Dict[str, str]], temperature: float = 0.3) -> str:
        headers = {"Authorization": self.authorization, "content-type": "application/json"}
        body = {
            "model": self.model,
            "user": "software_cup_user",
            "stream": self.enable_stream,
            "temperature": temperature,
            "messages": messages,
        }
        sem = self._get_model_semaphore(self.model, self.max_parallel)
        acquired = sem.acquire(timeout=self.acquire_timeout)
        if not acquired:
            raise RuntimeError(f"模型 {self.model} 并发繁忙（上限 {self.max_parallel}），请稍后重试。")
        resp = None
        try:
            for attempt in range(self.max_retries + 1):
                try:
                    self._wait_for_qps_slot()
                    resp = self.session.post(
                        self._request_url(),
                        json=body,
                        headers=headers,
                        timeout=self.timeout,
                        stream=body["stream"],
                    )
                    if self._is_qps_overflow_response(resp):
                        if attempt >= self.max_retries:
                            raise RuntimeError(f"请求失败: HTTP {resp.status_code}, {resp.text}")
                        backoff = self.retry_interval * (2**attempt) + random.uniform(0.0, 0.3)
                        time.sleep(backoff)
                        continue
                    break
                except requests.exceptions.Timeout as exc:
                    if attempt >= self.max_retries:
                        raise RuntimeError(
                            f"模型请求超时（模型: {self.model}, 超时: {self.timeout}）。"
                            "请切换模型或稍后重试。"
                        ) from exc
                    time.sleep(self.retry_interval)
                except requests.exceptions.ConnectionError as exc:
                    if attempt >= self.max_retries:
                        raise RuntimeError(f"无法连接模型服务，请检查网络或接口地址：{self.url}") from exc
                    time.sleep(self.retry_interval)
            if resp is None:
                raise RuntimeError("模型请求未发出，请重试。")
            try:
                if resp.status_code >= 400:
                    raise RuntimeError(f"请求失败: HTTP {resp.status_code}, {resp.text}")
                if body["stream"]:
                    content = self._read_stream_content(resp)
                    if not content:
                        raise RuntimeError("模型流式返回内容为空，请稍后重试。")
                    return content
                data = resp.json()
                content = self._extract_content(data)
                if not content:
                    raise RuntimeError(f"模型返回内容为空: {json.dumps(data, ensure_ascii=False)}")
                return content
            finally:
                resp.close()
        finally:
            sem.release()
