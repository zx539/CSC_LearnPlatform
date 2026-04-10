import json
import re
from pathlib import Path
from typing import Dict, List

from .spark_client import SparkClient


def extract_json_block(text: str) -> Dict:
    body = text.strip()
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{[\s\S]*\}", body)
    if not match:
        raise ValueError("未找到JSON结构")
    return json.loads(match.group(0))


class MultiAgentLearningSystem:
    REQUIRED_RESOURCE_TYPES = [
        "课程讲解文档",
        "知识点思维导图(Mermaid)",
        "分层练习题(含答案与解析)",
        "拓展阅读材料",
        "代码实操案例",
    ]

    def __init__(self, spark: SparkClient, kb_dir: str, output_dir: str):
        self.spark = spark
        self.kb_dir = Path(kb_dir)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def _read_knowledge_base(self, course: str) -> str:
        if not self.kb_dir.exists():
            return f"课程: {course}\n未提供本地知识库，按通识课程知识生成。"

        files = sorted(self.kb_dir.glob("*.md")) + sorted(self.kb_dir.glob("*.txt"))
        if not files:
            return f"课程: {course}\n知识库目录为空，按通识课程知识生成。"

        merged = []
        for file in files[:8]:
            content = file.read_text(encoding="utf-8", errors="ignore")
            merged.append(f"[{file.name}]\n{content[:5000]}")
        return f"课程: {course}\n\n" + "\n\n".join(merged)

    def build_or_update_profile(self, dialogue: str, old_profile: Dict | None = None) -> Dict:
        profile_snapshot = old_profile or {}
        system = (
            "你是学习画像智能体。根据学生对话构建或更新动态画像。"
            "必须返回严格JSON，不要输出任何额外说明。"
            "维度不少于6个，需包含: 专业/课程、学习目标、知识基础、认知风格、薄弱点、学习节奏、偏好资源类型、可投入时间。"
        )
        user = {
            "old_profile": profile_snapshot,
            "dialogue": dialogue,
            "output_schema": {
                "profile_version": "v1",
                "profile": {
                    "major": "",
                    "course": "",
                    "learning_goals": [],
                    "knowledge_level": "",
                    "cognitive_style": "",
                    "weak_points": [],
                    "learning_pace": "",
                    "preferred_modalities": [],
                    "weekly_available_hours": 0,
                },
                "confidence": 0.0,
                "next_questions": [],
            },
        }
        raw = self.spark.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(user, ensure_ascii=False)}],
            temperature=0.2,
        )
        return extract_json_block(raw)

    def _generate_single_resource(self, resource_type: str, topic: str, profile: Dict, kb_text: str) -> str:
        system = (
            "你是资源生成智能体。生成内容必须可直接用于学习。"
            "禁止编造不确定事实，不确定信息用【需核验】标记。"
            "内容必须个性化，显式贴合学生画像。"
        )
        user_prompt = (
            f"资源类型: {resource_type}\n"
            f"学习主题: {topic}\n"
            f"学生画像: {json.dumps(profile, ensure_ascii=False)}\n"
            f"课程知识库节选:\n{kb_text}\n\n"
            "请直接输出最终资源内容。"
        )
        return self.spark.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user_prompt}],
            temperature=0.5,
        )

    def generate_resources(self, topic: str, profile: Dict, course: str) -> Dict[str, str]:
        kb_text = self._read_knowledge_base(course)
        results: Dict[str, str] = {}
        for item in self.REQUIRED_RESOURCE_TYPES:
            results[item] = self._generate_single_resource(item, topic, profile, kb_text)
        return results

    def plan_learning_path(self, topic: str, profile: Dict, resources: Dict[str, str]) -> Dict:
        system = (
            "你是学习路径规划智能体。请结合画像与资源制定可执行路径。"
            "输出严格JSON，包含步骤顺序、每步目标、检查点、推荐资源。"
        )
        user = {
            "topic": topic,
            "profile": profile,
            "resource_keys": list(resources.keys()),
            "output_schema": {
                "path_name": "",
                "total_stages": 0,
                "stages": [
                    {
                        "stage_no": 1,
                        "goal": "",
                        "actions": [],
                        "recommended_resources": [],
                        "checkpoint": "",
                    }
                ],
                "push_strategy": {"daily_push_rules": [], "adaptive_rules": []},
            },
        }
        raw = self.spark.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(user, ensure_ascii=False)}],
            temperature=0.3,
        )
        return extract_json_block(raw)

    def tutor(self, question: str, profile: Dict, topic: str) -> str:
        system = (
            "你是智能辅导智能体。回答结构: 先结论，再原理，再例子。"
            "若用户基础薄弱，优先类比与步骤化表达。"
        )
        user = f"学习主题: {topic}\n学生画像: {json.dumps(profile, ensure_ascii=False)}\n问题: {question}"
        return self.spark.chat([{"role": "system", "content": system}, {"role": "user", "content": user}], temperature=0.4)

    def evaluate_learning(self, progress_text: str, profile: Dict, path: Dict) -> Dict:
        system = "你是学习效果评估智能体。输出严格JSON，给出多维评分、问题诊断和调整建议。"
        user = {
            "progress": progress_text,
            "profile": profile,
            "path": path,
            "output_schema": {
                "scores": {"knowledge_mastery": 0, "practice_accuracy": 0, "efficiency": 0, "stability": 0},
                "diagnosis": [],
                "plan_adjustments": [],
                "next_week_targets": [],
            },
        }
        raw = self.spark.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(user, ensure_ascii=False)}],
            temperature=0.2,
        )
        return extract_json_block(raw)

    def run(self, dialogue: str, course: str, topic: str, progress: str = "") -> Dict:
        profile_data = self.build_or_update_profile(dialogue)
        resources = self.generate_resources(topic=topic, profile=profile_data, course=course)
        path = self.plan_learning_path(topic=topic, profile=profile_data, resources=resources)
        report = {"profile": profile_data, "resources": resources, "learning_path": path}
        if progress.strip():
            report["evaluation"] = self.evaluate_learning(progress, profile_data, path)
        return report

    def save_report(self, report: Dict, output_name: str) -> Path:
        run_dir = self.output_dir / output_name
        run_dir.mkdir(parents=True, exist_ok=True)

        (run_dir / "profile.json").write_text(json.dumps(report["profile"], ensure_ascii=False, indent=2), encoding="utf-8")
        (run_dir / "learning_path.json").write_text(
            json.dumps(report["learning_path"], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        if "evaluation" in report:
            (run_dir / "evaluation.json").write_text(
                json.dumps(report["evaluation"], ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

        resources_dir = run_dir / "resources"
        resources_dir.mkdir(parents=True, exist_ok=True)
        for key, value in report["resources"].items():
            safe_name = re.sub(r"[\\/:*?\"<>|]", "_", key)
            (resources_dir / f"{safe_name}.md").write_text(value, encoding="utf-8")
        return run_dir

