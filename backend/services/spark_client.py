import json
import os
from pathlib import Path
from typing import Dict, List, Tuple

import requests


class SparkClient:
    def __init__(self, config_path: str, model: str = "4.0Ultra", timeout: int = 120):
        self.model = model
        self.timeout = timeout
        self.url, self.authorization = self._load_config(config_path)

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
        resp = requests.post(self.url, json=body, headers=headers, timeout=self.timeout)
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

