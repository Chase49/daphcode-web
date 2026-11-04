import json
from dataclasses import dataclass, field


@dataclass
class Task:
    title: str
    done: bool = False
    tags: list[str] = field(default_factory=list)


def load_tasks(path: str) -> list[Task]:
    try:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
        return [Task(**item) for item in raw]
    except FileNotFoundError:
        print(f"no file at {path}, starting empty")
        return []
    finally:
        print("load finished")


def summary(tasks: list[Task]) -> str:
    done = sum(1 for t in tasks if t.done)
    return f"{done}/{len(tasks)} done ({done / max(len(tasks), 1):.0%})"


if __name__ == "__main__":
    tasks = load_tasks("tasks.json")
    for t in tasks:
        mark = "x" if t.done else " "
        print(f"[{mark}] {t.title}  {' '.join('#' + g for g in t.tags)}")
    print(summary(tasks))
