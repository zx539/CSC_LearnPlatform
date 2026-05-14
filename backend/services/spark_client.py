import json
import os
import random
import time
from threading import Lock, Semaphore
from pathlib import Path
from typing import Dict, List, Tuple

import requests


class SparkClient:
    _DOUBAO_LITE_MODELS = {"doubao-lite", "seed2.0lite", "seed2-lite", "doubao-seed-2-0-lite-260428"}
    _DOUBAO_PRO_MODELS = {"doubao", "seed2.0pro", "seed2", "doubao-seed-2-0-pro-260215"}
    _DOUBAO_MODELS = _DOUBAO_LITE_MODELS | _DOUBAO_PRO_MODELS
    _semaphore_lock = Lock()
    _model_semaphores: Dict[str, Semaphore] = {}
    _qps_lock = Lock()
    _model_next_allowed_ts: Dict[str, float] = {}

    def __init__(self, config_path: str, model: str = "4.0Ultra", timeout: Tuple[int, int] | None = None):
        self.model = model
        model_key = str(self.model or "").strip().lower()
        doubao_like = model_key in self._DOUBAO_MODELS
        lite_like = ("lite" in model_key) or (model_key in self._DOUBAO_LITE_MODELS)
        connect_timeout = self._resolve_int_env(model_key, "CONNECT_TIMEOUT", "10")
        read_timeout = self._resolve_int_env(model_key, "READ_TIMEOUT", "240")
        self.timeout = timeout or (connect_timeout, read_timeout)
        default_retries = "6" if doubao_like else ("5" if lite_like else "2")
        self.max_retries = max(0, self._resolve_int_env(model_key, "MAX_RETRIES", default_retries))
        default_retry_interval = "1.5" if doubao_like else ("1.2" if lite_like else "1.0")
        self.retry_interval = max(0.0, self._resolve_float_env(model_key, "RETRY_INTERVAL", default_retry_interval))
        default_parallel = "1" if doubao_like else ("2" if lite_like else "5")
        self.max_parallel = max(1, self._resolve_int_env(model_key, "MAX_PARALLEL", default_parallel))
        default_qps = "0.4" if doubao_like else ("1.0" if lite_like else "3.0")
        self.max_qps = max(0.1, self._resolve_float_env(model_key, "MAX_QPS", default_qps))
        default_stream = "1" if lite_like else "0"
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
        if model_key in cls._DOUBAO_LITE_MODELS:
            value = os.getenv(f"DOUBAO_LITE_{suffix}") or os.getenv(f"DOUBAO_{suffix}") or shared or default
        elif model_key in cls._DOUBAO_PRO_MODELS:
            value = os.getenv(f"DOUBAO_PRO_{suffix}") or os.getenv(f"DOUBAO_{suffix}") or shared or default
        elif model_key in {"lite", "sparklite", "4.0lite"}:
            value = os.getenv(f"SPARK_LITE_{suffix}") or shared or default
        else:
            value = os.getenv(f"SPARK_ULTRA_{suffix}") or shared or default
        return cls._safe_int(value, cls._safe_int(default, 0))

    @classmethod
    def _resolve_float_env(cls, model_key: str, suffix: str, default: str) -> float:
        shared = os.getenv(f"SPARK_{suffix}")
        if model_key in cls._DOUBAO_LITE_MODELS:
            value = os.getenv(f"DOUBAO_LITE_{suffix}") or os.getenv(f"DOUBAO_{suffix}") or shared or default
        elif model_key in cls._DOUBAO_PRO_MODELS:
            value = os.getenv(f"DOUBAO_PRO_{suffix}") or os.getenv(f"DOUBAO_{suffix}") or shared or default
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

    @staticmethod
    def _normalize_url(url: str) -> str:
        normalized = str(url or "").strip()
        if normalized.startswith("//"):
            return f"https:{normalized}"
        return normalized

    def _load_config(self, config_path: str) -> Tuple[str, str]:
        model_key = str(self.model or "").strip().lower()
        if model_key in {"lite", "sparklite", "4.0lite"}:
            env_url = os.getenv("SPARK_LITE_API_URL") or os.getenv("SPARK_API_URL")
            env_auth = os.getenv("SPARK_LITE_API_AUTH") or os.getenv("SPARK_API_AUTH")
        elif model_key in self._DOUBAO_LITE_MODELS:
            env_url = os.getenv("DOUBAO_LITE_API_URL") or os.getenv("DOUBAO_API_URL")
            env_auth = (
                os.getenv("DOUBAO_LITE_API_AUTH")
                or os.getenv("DOUBAO_LITE_API_KEY")
                or os.getenv("DOUBAO_API_AUTH")
                or os.getenv("DOUBAO_API_KEY")
            )
        elif model_key in self._DOUBAO_PRO_MODELS:
            env_url = os.getenv("DOUBAO_PRO_API_URL") or os.getenv("DOUBAO_API_URL")
            env_auth = (
                os.getenv("DOUBAO_PRO_API_AUTH")
                or os.getenv("DOUBAO_PRO_API_KEY")
                or os.getenv("DOUBAO_API_AUTH")
                or os.getenv("DOUBAO_API_KEY")
            )
        else:
            env_url = os.getenv("SPARK_ULTRA_API_URL") or os.getenv("SPARK_API_URL")
            env_auth = os.getenv("SPARK_ULTRA_API_AUTH") or os.getenv("SPARK_API_AUTH")
        if env_url and env_auth:
            auth = env_auth if env_auth.lower().startswith("bearer ") else f"Bearer {env_auth}"
            return self._normalize_url(env_url), auth.strip()

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
        return self._normalize_url(url), auth

    def _request_url(self) -> str:
        model_key = str(self.model or "").strip().lower()
        base_url = str(self.url or "").strip().rstrip("/")
        if model_key in self._DOUBAO_MODELS:
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
            delta = choice.get("delta", {})
            if isinstance(delta, dict):
                text = self._extract_message_content(delta)
                if text:
                    return text
            message = choice.get("message", {})
            if isinstance(message, dict):
                text = self._extract_message_content(message)
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

    @staticmethod
    def _retry_after_seconds(resp: requests.Response) -> float:
        raw = str(resp.headers.get("Retry-After", "")).strip()
        if not raw:
            return 0.0
        try:
            return max(0.0, float(raw))
        except ValueError:
            return 0.0

    @staticmethod
    def _is_retryable_overload_response(resp: requests.Response) -> bool:
        if resp.status_code not in {429, 503, 504}:
            return False
        if resp.status_code == 504:
            return True
        text = (resp.text or "").strip()
        if "ServerOverloaded" in text or "TooManyRequests" in text:
            return True
        try:
            payload = resp.json()
        except ValueError:
            return resp.status_code in {429, 503, 504}
        if not isinstance(payload, dict):
            return resp.status_code in {429, 503, 504}
        err = payload.get("error", {})
        if not isinstance(err, dict):
            return resp.status_code in {429, 503, 504}
        code = str(err.get("code", "")).strip()
        err_type = str(err.get("type", "")).strip()
        message = str(err.get("message", "")).strip()
        return code in {"ServerOverloaded", "TooManyRequests"} or err_type == "TooManyRequests" or "overload" in message.lower()

    @staticmethod
    def _is_gateway_timeout_response(resp: requests.Response) -> bool:
        if resp.status_code != 504:
            return False
        text = (resp.text or "").lower()
        return (
            ("gateway time-out" in text)
            or ("gateway timeout" in text)
            or ("upstream timed out" in text)
            or (not text.strip())
        )

    def _build_gateway_timeout_error(self, resp: requests.Response) -> RuntimeError:
        model_key = str(self.model or "").strip().lower()
        hint = "模型服务网关超时（HTTP 504）"
        if model_key in self._DOUBAO_MODELS:
            hint += "（豆包模型高峰期常见）"
        return RuntimeError(
            f"{hint}。请稍后重试，或调低并发/QPS并增加重试次数。"
            f"模型={self.model}, URL={self._request_url()}"
        )

    def _looks_like_html_response(self, resp: requests.Response) -> bool:
        content_type = str(resp.headers.get("Content-Type", "")).lower()
        if "text/html" in content_type:
            return True
        sample = (resp.text or "").lstrip()[:256].lower()
        return sample.startswith("<!doctype html") or sample.startswith("<html")

    def _build_non_json_error(self, resp: requests.Response) -> RuntimeError:
        preview = (resp.text or "").replace("\n", " ").replace("\r", " ").strip()[:200]
        hint = "模型服务返回非JSON内容"
        model_key = str(self.model or "").strip().lower()
        if model_key in self._DOUBAO_MODELS:
            hint += f"（请检查 DOUBAO_API_URL / DOUBAO_LITE_API_URL 配置是否为豆包 API 地址）"
        return RuntimeError(f"{hint}: HTTP {resp.status_code}, URL={self._request_url()}, 响应片段={preview}")

    def _read_stream_content(self, resp: requests.Response) -> str:
        chunks: List[str] = []
        latest_message = ""
        for raw_line in resp.iter_lines(decode_unicode=False):
            if raw_line is None:
                continue
            if isinstance(raw_line, bytes):
                line = raw_line.decode("utf-8", errors="replace").strip()
            else:
                line = str(raw_line).strip()
            if not line:
                continue
            if line.startswith("data:"):
                line = line[5:].strip()
            if line == "[DONE]":
                break
            if line.lower().startswith("<!doctype html") or line.lower().startswith("<html"):
                raise self._build_non_json_error(resp)
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            choices = payload.get("choices", [])
            if not isinstance(choices, list) or not choices:
                continue
            choice = choices[0] if isinstance(choices[0], dict) else {}
            delta = choice.get("delta", {})
            delta_text = self._extract_message_content(delta) if isinstance(delta, dict) else ""
            if delta_text:
                chunks.append(delta_text)
                continue
            message = choice.get("message", {})
            message_text = self._extract_message_content(message) if isinstance(message, dict) else ""
            if message_text:
                # 某些服务端在流式分片中返回“累计全文”，此处只保留最新全文，避免重复拼接造成JSON损坏。
                latest_message = message_text
                continue
            text = str(choice.get("text", "")).strip()
            if text:
                chunks.append(text)
        assembled = "".join(chunks).strip()
        latest = latest_message.strip()
        if assembled and latest:
            # 两种模式并存时，优先更完整的文本（通常是累计全文）
            return latest if len(latest) >= len(assembled) else assembled
        return assembled or latest

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
                        resp.close()
                        time.sleep(backoff)
                        continue
                    if self._is_retryable_overload_response(resp):
                        if attempt >= self.max_retries:
                            if self._is_gateway_timeout_response(resp):
                                raise self._build_gateway_timeout_error(resp)
                            raise RuntimeError(f"请求失败: HTTP {resp.status_code}, {resp.text}")
                        retry_after = self._retry_after_seconds(resp)
                        backoff = max(retry_after, self.retry_interval * (2**attempt) + random.uniform(0.0, 0.6))
                        resp.close()
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
                    if self._is_gateway_timeout_response(resp):
                        raise self._build_gateway_timeout_error(resp)
                    raise RuntimeError(f"请求失败: HTTP {resp.status_code}, {resp.text}")
                if self._looks_like_html_response(resp):
                    raise self._build_non_json_error(resp)
                if body["stream"]:
                    content = self._read_stream_content(resp)
                    if not content:
                        raise RuntimeError("模型流式返回内容为空，请稍后重试。")
                    return content
                try:
                    data = resp.json()
                except ValueError as exc:
                    raise self._build_non_json_error(resp) from exc
                content = self._extract_content(data)
                if not content:
                    raise RuntimeError(f"模型返回内容为空: {json.dumps(data, ensure_ascii=False)}")
                return content
            finally:
                resp.close()
        finally:
            sem.release()
