#!/usr/bin/env python3
# encoding: UTF-8
import argparse
from pathlib import Path

from backend.services.multi_agent import MultiAgentLearningSystem
from backend.services.spark_client import SparkClient


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="基于星火大模型的个性化资源生成与学习多智能体系统（CLI版）")
    parser.add_argument("--config", default="materials/星火SoarkUltra-APIkey.txt", help="API配置文件路径")
    parser.add_argument("--course", required=True, help="课程名称，如: 人工智能导论")
    parser.add_argument("--topic", required=True, help="学习主题，如: 机器学习基础")
    parser.add_argument("--dialogue", required=True, help="学生画像对话输入")
    parser.add_argument("--progress", default="", help="学习进展描述(可选，用于学习效果评估)")
    parser.add_argument("--output", default="latest_run", help="输出目录名称")
    parser.add_argument("--kb-dir", default="data/knowledge_base", help="知识库目录")
    parser.add_argument("--model", default="4.0Ultra", help="调用模型名称")
    return parser.parse_args()


def main():
    args = parse_args()
    client = SparkClient(config_path=args.config, model=args.model)
    system = MultiAgentLearningSystem(spark=client, kb_dir=args.kb_dir, output_dir="outputs")
    report = system.run(dialogue=args.dialogue, course=args.course, topic=args.topic, progress=args.progress)
    output_path = system.save_report(report, args.output)
    print(f"已生成个性化学习资源，输出目录: {Path(output_path).resolve()}")


if __name__ == "__main__":
    main()
