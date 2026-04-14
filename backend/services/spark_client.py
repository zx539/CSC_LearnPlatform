import json
import os
import time
from threading import Lock, Semaphore
from pathlib import Path
from typing import Dict, List, Tuple

import requests


class SparkClient:
    _semaphore_lock = Lock()
    _model_semaphores: Dict[str, Semaphore] = {}

    def __init__(self, config_path: str, model: str = "4.0Ultra", timeout: Tuple[int, int] | None = None):
        self.model = model
        connect_timeout = int(os.getenv("SPARK_CONNECT_TIMEOUT", "10"))
        read_timeout = int(os.getenv("SPARK_READ_TIMEOUT", "240"))
        self.timeout = timeout or (connect_timeout, read_timeout)
        self.max_retries = max(0, int(os.getenv("SPARK_MAX_RETRIES", "2")))
        self.retry_interval = float(os.getenv("SPARK_RETRY_INTERVAL", "1.0"))
        self.max_parallel = max(1, int(os.getenv("SPARK_MAX_PARALLEL", "5")))
        self.acquire_timeout = int(os.getenv("SPARK_ACQUIRE_TIMEOUT", "300"))
        self.url, self.authorization = self._load_config(config_path)

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
        env_url = os.getenv("SPARK_API_URL")
        env_auth = os.getenv("SPARK_API_AUTH")
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

    def chat(self, messages: List[Dict[str, str]], temperature: float = 0.3) -> str:
        headers = {"Authorization": self.authorization, "content-type": "application/json"}
        body = {
            "model": self.model,
            "user": "software_cup_user",
            "stream": False,
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
                    resp = requests.post(self.url, json=body, headers=headers, timeout=self.timeout)
                    break
                except requests.exceptions.Timeout as exc:
                    if attempt >= self.max_retries:
                        raise RuntimeError(
                            f"星火请求超时（模型: {self.model}, 超时: {self.timeout}）。"
                            "请切换为 lite 模型或稍后重试。"
                        ) from exc
                    time.sleep(self.retry_interval)
                except requests.exceptions.ConnectionError as exc:
                    if attempt >= self.max_retries:
                        raise RuntimeError(f"无法连接星火服务，请检查网络或接口地址：{self.url}") from exc
                    time.sleep(self.retry_interval)
            if resp is None:
                raise RuntimeError("星火请求未发出，请重试。")
            if resp.status_code >= 400:
                raise RuntimeError(f"请求失败: HTTP {resp.status_code}, {resp.text}")

            data = resp.json()
            choices = data.get("choices", [])
            if not choices:
                raise RuntimeError(f"模型返回异常: {json.dumps(data, ensure_ascii=False)}")

            message = choices[0].get("message", {})
            content = message.get("content", "")
            if not content:
                raise RuntimeError(f"模型返回内容为空: {json.dumps(data, ensure_ascii=False)}")
            return content
        finally:
            sem.release()
