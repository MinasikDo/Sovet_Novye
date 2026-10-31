"""Чистая логика подсчёта голосов (с русскими формулировками)."""
from dataclasses import dataclass

@dataclass
class VoteTally:
    for_: int = 0
    against: int = 0
    abstain: int = 0

    @property
    def voters(self) -> int:
        return self.for_ + self.against + self.abstain

@dataclass
class Verdict:
    passed: bool
    reason: str
    needed: int | None = None

def quorum_threshold(total_members: int) -> int:
    """Ст. 19.1: более половины → не менее 9 из 16."""
    return total_members // 2 + 1

def has_quorum(present: int, total_members: int) -> bool:
    return present >= quorum_threshold(total_members)

def evaluate(tally: VoteTally, present: int, total_members: int,
             majority_type: str, choices_counts: list[int] | None = None) -> Verdict:
    
    quorum_ok = has_quorum(present, total_members)
    needed_quorum = quorum_threshold(total_members)
    n = tally.voters

    if not quorum_ok:
        return Verdict(False, "Нет кворума на момент завершения голосования", needed_quorum)

    if majority_type == "simple":
        if n == 0: return Verdict(False, "Голоса не поданы")
        needed = n // 2 + 1
        return Verdict(tally.for_ >= needed, "Простое большинство", needed)

    if majority_type == "qualified_11":
        return Verdict(tally.for_ >= 11, "Квалифицированное большинство (≥11)", 11)

    if majority_type == "two_thirds":
        if n == 0: return Verdict(False, "Голоса не поданы")
        needed = (2 * n + 2) // 3
        return Verdict(tally.for_ >= needed, "Две трети", needed)

    if majority_type == "plurality":
        if not choices_counts: return Verdict(False, "Нет кандидатов")
        top = max(choices_counts)
        if top == 0: return Verdict(False, "Голоса не поданы", 1)
        tie = choices_counts.count(top) > 1
        return Verdict(not tie, "Ничья — требуется 2-й тур" if tie else "Наибольшее число голосов", top)

    raise ValueError(f"Неизвестный тип большинства: {majority_type}")

def describe(verdict: Verdict) -> str:
    base = verdict.reason
    return ("ПРИНЯТО" if verdict.passed else "НЕ ПРИНЯТО") + f" — {base}"