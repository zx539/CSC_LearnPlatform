import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

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


def _stringify(value: Any) -> str:
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False)


class MultiAgentLearningSystem:
    REQUIRED_RESOURCE_TYPES = [
        "课程讲解文档",
        "知识点思维导图(Mermaid)",
        "分层练习题(含答案与解析)",
        "拓展阅读材料",
        "代码实操案例",
        "视频学习资料",
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
        extra_requirement = ""
        if resource_type == "视频学习资料":
            extra_requirement = (
                "请输出Markdown格式，至少给出5条视频学习资料，优先可公开访问。"
                "每条需包含：标题、平台、链接、适合人群、建议观看顺序与时长。"
            )
        user_prompt = (
            f"资源类型: {resource_type}\n"
            f"学习主题: {topic}\n"
            f"学生画像: {json.dumps(profile, ensure_ascii=False)}\n"
            f"课程知识库节选:\n{kb_text}\n\n"
            f"{extra_requirement}\n"
            "请直接输出最终资源内容。"
        )
        return self.spark.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user_prompt}],
            temperature=0.5,
        )

    def build_report_markdown(self, report: Dict) -> Dict[str, str]:
        profile_md = self._profile_to_markdown(report.get("profile", {}))
        path_md = self._learning_path_to_markdown(report.get("learning_path", {}))
        progress_form_md = self._progress_form_to_markdown(report.get("progress_form_template", {}))
        test_form_md = self._progress_form_to_markdown(report.get("test_form_template", {}))
        evaluation_obj = report.get("evaluation", {"summary": "本次未提供学习进度，暂未生成评估。"})
        evaluation_md = self._evaluation_to_markdown(evaluation_obj)
        questionnaire_history = report.get("questionnaire_history", []) or []
        history_blocks: List[str] = []
        for item in questionnaire_history:
            if not isinstance(item, dict):
                continue
            stage_no = _stringify(item.get("stage_no", ""))
            form_type = _stringify(item.get("form_type", "progress")) or "progress"
            form_md = _stringify(item.get("markdown", ""))
            if not form_md:
                continue
            form_title = "学习进度调查问卷" if form_type == "progress" else "学习测试问卷"
            history_blocks.append(f"## 问卷记录（{form_title} · 阶段 {stage_no or '未知'}）\n\n{form_md}")
        questionnaire_history_md = "\n\n".join(history_blocks).strip()

        resource_blocks: List[str] = []
        for name, content in report.get("resources", {}).items():
            resource_blocks.append(f"## 资源：{name}\n\n{content}\n")
        resources_md = "\n".join(resource_blocks)

        full_report_md = "\n\n".join(
            [profile_md, resources_md, path_md, progress_form_md, test_form_md, evaluation_md, questionnaire_history_md]
        ).strip() + "\n"
        return {
            "profile_md": profile_md,
            "resources_md": resources_md,
            "learning_path_md": path_md,
            "progress_form_md": progress_form_md,
            "test_form_md": test_form_md,
            "evaluation_md": evaluation_md,
            "questionnaire_history_md": questionnaire_history_md,
            "full_report_md": full_report_md,
        }

    def _profile_to_markdown(self, profile_data: Dict) -> str:
        profile = profile_data.get("profile", {})
        goals = profile.get("learning_goals", []) or []
        weak_points = profile.get("weak_points", []) or []
        modalities = profile.get("preferred_modalities", []) or []
        next_questions = profile_data.get("next_questions", []) or []
        return (
            "## 学习画像\n\n"
            f"- **专业/课程**：{_stringify(profile.get('major', ''))} / {_stringify(profile.get('course', ''))}\n"
            f"- **知识基础**：{_stringify(profile.get('knowledge_level', ''))}\n"
            f"- **认知风格**：{_stringify(profile.get('cognitive_style', ''))}\n"
            f"- **学习节奏**：{_stringify(profile.get('learning_pace', ''))}\n"
            f"- **每周可投入时间**：{_stringify(profile.get('weekly_available_hours', ''))} 小时\n\n"
            f"### 学习目标\n{self._list_to_markdown(goals)}\n\n"
            f"### 薄弱点\n{self._list_to_markdown(weak_points)}\n\n"
            f"### 偏好资源类型\n{self._list_to_markdown(modalities)}\n\n"
            f"### 画像置信度\n- **置信度**：{_stringify(profile_data.get('confidence', ''))}\n\n"
            f"### 后续澄清问题\n{self._list_to_markdown(next_questions)}\n"
        )

    def _learning_path_to_markdown(self, path: Dict) -> str:
        stages = path.get("stages", []) or []
        stage_blocks: List[str] = []
        for stage in stages:
            stage_blocks.append(
                f"### 阶段 {stage.get('stage_no', '')}：{_stringify(stage.get('goal', ''))}\n"
                f"- **行动项**：{self._inline_list(stage.get('actions', []))}\n"
                f"- **推荐资源**：{self._inline_list(stage.get('recommended_resources', []))}\n"
                f"- **检查点**：{_stringify(stage.get('checkpoint', ''))}\n"
            )
        push = path.get("push_strategy", {})
        return (
            "## 学习路径\n\n"
            f"- **路径名称**：{_stringify(path.get('path_name', ''))}\n"
            f"- **总阶段数**：{_stringify(path.get('total_stages', 0))}\n\n"
            f"{''.join(stage_blocks) if stage_blocks else '- 暂无阶段信息'}\n"
            "### 推送策略\n"
            f"- **日常推送规则**：{self._inline_list(push.get('daily_push_rules', []))}\n"
            f"- **自适应规则**：{self._inline_list(push.get('adaptive_rules', []))}\n"
        )

    def _progress_form_to_markdown(self, form_template: Dict) -> str:
        questions = form_template.get("questions", []) or []
        blocks: List[str] = []
        for idx, item in enumerate(questions, start=1):
            q_type = _stringify(item.get("type", "text"))
            required_text = "必填" if bool(item.get("required", True)) else "选填"
            options = item.get("options", []) or []
            option_text = ""
            if options:
                option_lines = "\n".join([f"  - {opt}" for opt in options])
                option_text = f"\n- **可选项**：\n{option_lines}"
            blocks.append(
                f"### Q{idx}. {_stringify(item.get('question', ''))}\n"
                f"- **题型**：{q_type}\n"
                f"- **是否必填**：{required_text}\n"
                f"- **评估维度**：{_stringify(item.get('dimension', '学习进度'))}"
                f"{option_text}\n"
            )
        return (
            f"## {_stringify(form_template.get('form_title', '学习进度问卷'))}\n\n"
            f"{_stringify(form_template.get('instructions', '请按真实学习情况作答，提交后将用于评估。'))}\n\n"
            f"{''.join(blocks) if blocks else '- 暂无可用问卷题目，请先生成学习路径。'}\n"
        )

    def _evaluation_to_markdown(self, evaluation: Dict) -> str:
        stage_progress = evaluation.get("stage_progress", []) or []
        stage_lines: List[str] = []
        for item in stage_progress:
            stage_lines.append(
                f"### 阶段 {item.get('stage_no', '')}：{_stringify(item.get('goal', ''))}\n"
                f"- **计划完成度**：{_stringify(item.get('completion_rate', ''))}%\n"
                f"- **掌握质量**：{_stringify(item.get('quality_score', ''))}/100\n"
                f"- **关键问题**：{self._inline_list(item.get('issues', []))}\n"
                f"- **改进动作**：{self._inline_list(item.get('next_actions', []))}\n"
            )
        efficiency = evaluation.get("study_efficiency", {})
        return (
            "## 学习评估\n\n"
            f"- **总体结论**：{_stringify(evaluation.get('summary', ''))}\n"
            f"- **综合评分**：{_stringify(evaluation.get('overall_score', ''))}/100\n\n"
            "### 分阶段评估\n"
            f"{''.join(stage_lines) if stage_lines else '- 暂无分阶段评估数据'}\n"
            "### 效率分析\n"
            f"- **计划时长**：{_stringify(efficiency.get('planned_hours', ''))} h\n"
            f"- **实际时长**：{_stringify(efficiency.get('actual_hours', ''))} h\n"
            f"- **偏差说明**：{_stringify(efficiency.get('deviation_note', ''))}\n\n"
            f"### 风险提醒\n{self._list_to_markdown(evaluation.get('risk_alerts', []))}\n\n"
            f"### 下阶段目标\n{self._list_to_markdown(evaluation.get('next_week_targets', []))}\n"
        )

    def _list_to_markdown(self, values: List[Any]) -> str:
        if not values:
            return "- 暂无"
        return "\n".join(f"- { _stringify(item) }" for item in values)

    def _inline_list(self, values: List[Any]) -> str:
        if not values:
            return "暂无"
        return "；".join(_stringify(item) for item in values)

    def generate_resources(self, topic: str, profile: Dict, course: str) -> Dict[str, str]:
        kb_text = self._read_knowledge_base(course)
        results: Dict[str, str] = {}
        for item in self.REQUIRED_RESOURCE_TYPES:
            results[item] = self._generate_single_resource(item, topic, profile, kb_text)
        return results

    def _normalize_question_type(self, raw_type: str) -> str:
        t = (raw_type or "").strip().lower()
        if t in {"single", "single_choice", "radio", "单选"}:
            return "single_choice"
        if t in {"multiple", "multi_choice", "checkbox", "多选"}:
            return "multi_choice"
        if t in {"scale", "rating", "量表"}:
            return "scale"
        return "text"

    def _find_stage(self, path: Dict, stage_no: int) -> Dict[str, Any]:
        stages = path.get("stages", []) or []
        for stage in stages:
            raw_no = stage.get("stage_no", 0)
            try:
                if int(raw_no) == stage_no:
                    return stage
            except (TypeError, ValueError):
                continue
        if stages:
            return stages[min(stage_no - 1, len(stages) - 1)]
        return {"stage_no": stage_no, "goal": "该阶段学习目标"}

    def _default_progress_questions(self, path: Dict, stage_no: int) -> List[Dict[str, Any]]:
        stage = self._find_stage(path, stage_no)
        stage_goal = _stringify(stage.get("goal", "该阶段学习目标"))
        return [
            {
                "id": f"stage_{stage_no}_quiz_1",
                "question": f"【阶段{stage_no}测试】与“{stage_goal}”最相关的核心概念你掌握到什么程度？",
                "type": "single_choice",
                "options": ["仅了解名词", "能解释原理", "能独立解题", "能迁移应用"],
                "required": True,
                "dimension": "知识掌握",
            },
            {
                "id": f"stage_{stage_no}_quiz_2",
                "question": "请给出本阶段一道你能独立完成的关键题型或任务。",
                "type": "text",
                "options": [],
                "required": True,
                "dimension": "能力输出",
            },
            {
                "id": f"stage_{stage_no}_completion",
                "question": "你在本阶段学习计划中的完成度如何？",
                "type": "single_choice",
                "options": ["0-25%", "26-50%", "51-75%", "76-100%"],
                "required": True,
                "dimension": "阶段完成度",
            },
            {
                "id": f"stage_{stage_no}_difficulty",
                "question": "本阶段学习难度体感如何？",
                "type": "scale",
                "options": ["1", "2", "3", "4", "5"],
                "required": True,
                "dimension": "学习难度",
            },
            {
                "id": f"stage_{stage_no}_blocker",
                "question": "本阶段最大的阻碍是什么？",
                "type": "text",
                "options": [],
                "required": True,
                "dimension": "问题诊断",
            },
        ]

    def build_progress_form(
        self,
        topic: str,
        path: Dict,
        profile: Dict,
        stage_no: int = 1,
        last_checkin: Dict | None = None,
        last_evaluation: Dict | None = None,
    ) -> Dict:
        stage = self._find_stage(path, stage_no)
        stage_goal = _stringify(stage.get("goal", "该阶段学习目标"))
        system = (
            "你是阶段学习测试与进度问卷生成智能体。"
            "先生成可操作的小测试题，再附带进度调查题。"
            "必须返回严格JSON，不要输出任何解释。"
            "题目要与当前阶段目标强相关，优先单选/多选/量表，保留少量文本题。"
        )
        user = {
            "topic": topic,
            "profile": profile,
            "learning_path": path,
            "current_stage_no": stage_no,
            "current_stage_goal": stage_goal,
            "last_checkin": last_checkin or {},
            "last_evaluation": last_evaluation or {},
            "output_schema": {
                "form_version": "v3",
                "form_title": f"阶段{stage_no}学习测试与进度问卷",
                "stage_no": stage_no,
                "stage_goal": stage_goal,
                "instructions": "请先完成阶段测试，再填写进度反馈，提交后将用于评估并生成下一阶段问卷。",
                "questions": [
                    {
                        "id": "q1",
                        "question": "",
                        "type": "single_choice",
                        "options": ["", ""],
                        "required": True,
                        "dimension": "",
                    }
                ],
                "rule": "每完成一次阶段测试并提交后，系统生成下一阶段问卷。",
            },
        }
        raw = self.spark.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(user, ensure_ascii=False)}],
            temperature=0.3,
        )
        parsed = extract_json_block(raw)
        questions = parsed.get("questions", [])
        normalized: List[Dict[str, Any]] = []
        if isinstance(questions, list):
            for i, q in enumerate(questions, start=1):
                if not isinstance(q, dict):
                    continue
                q_type = self._normalize_question_type(_stringify(q.get("type", "")))
                options = q.get("options", [])
                if not isinstance(options, list):
                    options = []
                options = [_stringify(opt) for opt in options if _stringify(opt)]
                if q_type in {"single_choice", "multi_choice", "scale"} and not options:
                    if q_type == "scale":
                        options = ["1", "2", "3", "4", "5"]
                    else:
                        options = ["A", "B", "C", "D"]
                normalized.append(
                    {
                        "id": _stringify(q.get("id", f"q{i}")) or f"q{i}",
                        "question": _stringify(q.get("question", "")) or f"问题{i}",
                        "type": q_type,
                        "options": options,
                        "required": bool(q.get("required", True)),
                        "dimension": _stringify(q.get("dimension", "学习进度")),
                    }
                )
        if not normalized:
            normalized = self._default_progress_questions(path, stage_no)
        return {
            "form_version": _stringify(parsed.get("form_version", "v3")) or "v3",
            "topic": topic,
            "stage_no": stage_no,
            "stage_goal": stage_goal,
            "form_title": _stringify(parsed.get("form_title", f"阶段{stage_no}学习测试与进度问卷"))
            or f"阶段{stage_no}学习测试与进度问卷",
            "instructions": _stringify(
                parsed.get("instructions", "请先完成阶段测试，再填写进度反馈，提交后将用于评估并生成下一阶段问卷。")
            ),
            "questions": normalized,
            "rule": _stringify(parsed.get("rule", "每完成一次阶段测试并提交后，系统生成下一阶段问卷。")),
        }

    def _default_test_questions(self, path: Dict, stage_no: int) -> List[Dict[str, Any]]:
        stage = self._find_stage(path, stage_no)
        stage_goal = _stringify(stage.get("goal", "该阶段学习目标"))
        return [
            {
                "id": f"stage_{stage_no}_test_1",
                "question": f"【阶段{stage_no}测试】你认为“{stage_goal}”最关键的判断标准是什么？",
                "type": "single_choice",
                "options": ["能复述定义", "能解释原理", "能独立完成题目", "能迁移到新问题"],
                "required": True,
                "dimension": "阶段测试",
            },
            {
                "id": f"stage_{stage_no}_test_2",
                "question": "请用 1-2 句话说明你本阶段最有把握的知识点。",
                "type": "text",
                "options": [],
                "required": True,
                "dimension": "阶段测试",
            },
            {
                "id": f"stage_{stage_no}_test_3",
                "question": "请用 1-2 句话说明你仍然不确定的知识点。",
                "type": "text",
                "options": [],
                "required": True,
                "dimension": "阶段测试",
            },
        ]

    def build_test_form(
        self,
        topic: str,
        path: Dict,
        profile: Dict,
        stage_no: int = 1,
        last_checkin: Dict | None = None,
        last_evaluation: Dict | None = None,
    ) -> Dict:
        stage = self._find_stage(path, stage_no)
        stage_goal = _stringify(stage.get("goal", "该阶段学习目标"))
        system = (
            "你是学习阶段测试问卷生成智能体。"
            "请针对当前阶段目标生成可操作的测试题，帮助判断是否可以进入下一阶段。"
            "必须返回严格JSON，不要输出任何解释。"
        )
        user = {
            "topic": topic,
            "profile": profile,
            "learning_path": path,
            "current_stage_no": stage_no,
            "current_stage_goal": stage_goal,
            "last_progress_checkin": last_checkin or {},
            "last_evaluation": last_evaluation or {},
            "output_schema": {
                "form_version": "v1-test",
                "form_title": f"阶段{stage_no}学习测试问卷",
                "stage_no": stage_no,
                "stage_goal": stage_goal,
                "instructions": "请在完成本阶段学习后作答。提交后系统将生成下一次进入软件需填写的学习进度调查问卷。",
                "questions": [
                    {
                        "id": "t1",
                        "question": "",
                        "type": "single_choice",
                        "options": ["", ""],
                        "required": True,
                        "dimension": "阶段测试",
                    }
                ],
                "rule": "测试问卷可选填；仅在提交测试问卷后才更新下一次学习进度调查问卷。",
            },
        }
        raw = self.spark.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(user, ensure_ascii=False)}],
            temperature=0.3,
        )
        parsed = extract_json_block(raw)
        questions = parsed.get("questions", [])
        normalized: List[Dict[str, Any]] = []
        if isinstance(questions, list):
            for i, q in enumerate(questions, start=1):
                if not isinstance(q, dict):
                    continue
                q_type = self._normalize_question_type(_stringify(q.get("type", "")))
                options = q.get("options", [])
                if not isinstance(options, list):
                    options = []
                options = [_stringify(opt) for opt in options if _stringify(opt)]
                if q_type in {"single_choice", "multi_choice", "scale"} and not options:
                    if q_type == "scale":
                        options = ["1", "2", "3", "4", "5"]
                    else:
                        options = ["A", "B", "C", "D"]
                normalized.append(
                    {
                        "id": _stringify(q.get("id", f"t{i}")) or f"t{i}",
                        "question": _stringify(q.get("question", "")) or f"测试问题{i}",
                        "type": q_type,
                        "options": options,
                        "required": bool(q.get("required", True)),
                        "dimension": _stringify(q.get("dimension", "阶段测试")),
                    }
                )
        if not normalized:
            normalized = self._default_test_questions(path, stage_no)
        return {
            "form_version": _stringify(parsed.get("form_version", "v1-test")) or "v1-test",
            "topic": topic,
            "stage_no": stage_no,
            "stage_goal": stage_goal,
            "form_title": _stringify(parsed.get("form_title", f"阶段{stage_no}学习测试问卷")) or f"阶段{stage_no}学习测试问卷",
            "instructions": _stringify(
                parsed.get("instructions", "请在完成本阶段学习后作答。提交后系统将生成下一次进入软件需填写的学习进度调查问卷。")
            ),
            "questions": normalized,
            "rule": _stringify(parsed.get("rule", "测试问卷可选填；仅在提交测试问卷后才更新下一次学习进度调查问卷。")),
        }

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

    def tutor(self, question: str, profile: Dict, topic: str, memory: List[Dict[str, str]] | None = None) -> str:
        system = (
            "你是智能辅导智能体。回答结构: 先结论，再原理，再例子。"
            "若用户基础薄弱，优先类比与步骤化表达。"
        )
        memory = memory or []
        memory_lines: List[str] = []
        for idx, item in enumerate(memory[-20:], start=1):
            q = _stringify(item.get("question", ""))
            a = _stringify(item.get("answer", ""))
            if not q and not a:
                continue
            memory_lines.append(f"{idx}. 用户问题: {q}\n   你的回答: {a}")
        memory_block = "\n".join(memory_lines) if memory_lines else "无"
        user = (
            f"学习主题: {topic}\n"
            f"学生画像: {json.dumps(profile, ensure_ascii=False)}\n"
            f"历史对话记忆:\n{memory_block}\n"
            f"当前问题: {question}"
        )
        return self.spark.chat([{"role": "system", "content": system}, {"role": "user", "content": user}], temperature=0.4)

    def evaluate_learning(self, progress_payload: Dict, profile: Dict, path: Dict) -> Dict:
        system = (
            "你是学习效果评估智能体。请基于学习路径与学习进度进行详细评估。"
            "学习进度输入是问卷作答结果，请充分利用作答内容。"
            "输出严格JSON，必须包含总体结论、综合评分、按阶段评估、效率分析、风险提醒、下一步目标。"
        )
        user = {
            "progress": progress_payload,
            "profile": profile,
            "path": path,
            "output_schema": {
                "summary": "",
                "overall_score": 0,
                "stage_progress": [
                    {
                        "stage_no": 1,
                        "goal": "",
                        "completion_rate": 0,
                        "quality_score": 0,
                        "issues": [],
                        "next_actions": [],
                    }
                ],
                "study_efficiency": {"planned_hours": 0, "actual_hours": 0, "deviation_note": ""},
                "risk_alerts": [],
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
        stages = path.get("stages", []) or []
        total_stages = len(stages) if stages else 1
        current_stage_no = 1
        progress_form_template = self.build_progress_form(topic=topic, path=path, profile=profile_data, stage_no=current_stage_no)
        test_form_template = self.build_test_form(topic=topic, path=path, profile=profile_data, stage_no=current_stage_no)
        progress_form_md = self._progress_form_to_markdown(progress_form_template)
        test_form_md = self._progress_form_to_markdown(test_form_template)
        report = {
            "profile": profile_data,
            "resources": resources,
            "learning_path": path,
            "progress_form_template": progress_form_template,
            "test_form_template": test_form_template,
            "questionnaire_history": [
                {
                    "form_type": "progress",
                    "stage_no": current_stage_no,
                    "created_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "form": progress_form_template,
                    "markdown": progress_form_md,
                },
                {
                    "form_type": "test",
                    "stage_no": current_stage_no,
                    "created_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "form": test_form_template,
                    "markdown": test_form_md,
                },
            ],
            "stage_state": {"current_stage_no": current_stage_no, "total_stages": total_stages},
        }
        if progress.strip():
            report["evaluation"] = self.evaluate_learning({"reflection": progress}, profile_data, path)
        return report

    def save_report(self, report: Dict, output_name: str) -> tuple[Path, Dict[str, str]]:
        run_dir = self.output_dir / output_name
        run_dir.mkdir(parents=True, exist_ok=True)

        resources_dir = run_dir / "resources"
        resources_dir.mkdir(parents=True, exist_ok=True)
        for key, value in report["resources"].items():
            safe_name = re.sub(r"[\\/:*?\"<>|]", "_", key)
            (resources_dir / f"{safe_name}.md").write_text(value, encoding="utf-8")

        markdown_payload = self.build_report_markdown(report)
        self.persist_markdown_files(run_dir, markdown_payload)
        self.persist_questionnaire_markdown_files(run_dir, report.get("questionnaire_history", []))
        return run_dir, markdown_payload

    def persist_markdown_files(self, run_dir: Path, markdown_payload: Dict[str, str]):
        run_dir.mkdir(parents=True, exist_ok=True)
        markdown_dir = run_dir / "markdown"
        markdown_dir.mkdir(parents=True, exist_ok=True)

        files = {
            "学习画像.md": markdown_payload.get("profile_md", ""),
            "学习路径.md": markdown_payload.get("learning_path_md", ""),
            "学习进度表单.md": markdown_payload.get("progress_form_md", ""),
            "学习测试问卷.md": markdown_payload.get("test_form_md", ""),
            "学习评估.md": markdown_payload.get("evaluation_md", ""),
            "学习问卷历史.md": markdown_payload.get("questionnaire_history_md", ""),
            "AI返回总览.md": markdown_payload.get("full_report_md", ""),
        }
        for name, content in files.items():
            (markdown_dir / name).write_text(content, encoding="utf-8")
            (run_dir / name).write_text(content, encoding="utf-8")

    def persist_questionnaire_markdown_files(self, run_dir: Path, history: List[Dict[str, Any]]):
        markdown_dir = run_dir / "markdown"
        markdown_dir.mkdir(parents=True, exist_ok=True)
        if not isinstance(history, list):
            return
        for idx, item in enumerate(history, start=1):
            if not isinstance(item, dict):
                continue
            stage_no = _stringify(item.get("stage_no", idx)) or str(idx)
            form_type = _stringify(item.get("form_type", "progress")) or "progress"
            md = _stringify(item.get("markdown", ""))
            if not md.strip():
                continue
            prefix = "学习进度调查问卷" if form_type == "progress" else "学习测试问卷"
            file_name = f"{prefix}_阶段{stage_no}_第{idx}版.md"
            (markdown_dir / file_name).write_text(md, encoding="utf-8")
            (run_dir / file_name).write_text(md, encoding="utf-8")
