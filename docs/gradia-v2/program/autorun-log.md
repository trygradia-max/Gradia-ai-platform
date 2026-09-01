# AUTORUN log

_Append-only. One block per ticket. Builder writes plan + result; Reviewer appends verdict; founder appends acceptance/merge. Format below._

```
## <TICKET> — <title>
- Session: <date/time> · Batch: <n> · Branch: <name>
- Plan: (≤10 lines)
- Result: DONE | BLOCKED | STOPPED — commit <hash>
- Validation: unit <n> · int <n> · tsc ✓ · lint ✓ · build ✓
- Residuals: MEDIUM … / LOW …
- Needs founder: …
- Reviewer: (verdict, findings, review-fix commit)
- Founder: (acceptance PASS/FAIL, merged <hash>)
- NEXT: <next queue item>
```
