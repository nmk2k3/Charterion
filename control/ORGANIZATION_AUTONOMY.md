# Organization autonomy: Git evidence → test → review → promotion

This implementation uses **the existing Charterion ChatGPT Web extension and native host**.
It does not call a paid model API. The Kernel is the authority for durable
WorkItems, Git worktrees, machine verification, test evidence and review.

## State machine

1. `org-work.reconcile` or the daemon scheduler projects runnable Mission WorkItems.
2. The extension sees projected Kernel tasks and dispatches to an acquired, bound ChatGPT Web Agent tab.
3. A Developer produces a committed change **in the assigned worktree**. The scoped
   capability submits the claim and calls `claim.verify`.
4. The same capability calls `org-work.complete`. The Kernel checks the exact
   WorkItem/AgentSlot binding, records a WorkOutcome, and only then revokes the
   workspace token. The completed commit becomes the Tester dependency base.
5. A Tester records `node:test` evidence for **the exact HEAD SHA**, commits any
   owned test changes, then submits/verifies the claim and completes its WorkItem.
   A Git-valid claim with failed/missing tests **does not** set machineCompletion.
6. If tests failed, the scheduler creates up to three durable
   Developer Fix → Tester Retest rounds. The old Tester is cancelled, never marked
   completed; pending reviewer dependencies move to the latest Tester.
7. After a passing Tester WorkOutcome, `OrganizationReviewRelease` opens an
   exact-head Change Request and materializes Review Pool dimensions. Every
   reviewer is an independent Organization Agent.
8. Approval of all required slots authorizes Supervisor approval and a
   fast-forward candidate promotion. Each review work item receives an auditable
   structured WorkOutcome.
9. The Mission may complete only after its remaining review work is done.

The scheduler is idempotent under process restarts and restarts from SQLite.
It does **not** assume an AI text reply is execution evidence.

## Windows operator setup

Build the extension, native host and control plane using the project's normal
Windows setup instructions. Set the environment below **before launching gamd**:

```powershell
# Default: Kernel scheduler active. Disable explicitly for diagnostics.
$env:GAM_DISABLE_AUTONOMY = '0'

# Optional: only for a trusted repository whose tests you are willing to run
# under your local Windows user. This executes project-controlled Node code.
$env:GAM_ALLOW_AGENT_TEST_RUNS = '1'
```

With the test-execution switch unset, only an authenticated admin can call
`org-test.run`. This is safer for repositories containing untrusted AI-generated
tests. No arbitrary shell command is accepted by the test RPC.

Useful admin RPC methods:

```powershell
npm run gamctl -- org-autonomy.tick --admin --params '{"projectId":"<projectId>"}'
npm run gamctl -- org-review.release --admin --params '{"workItemId":"<testerWorkItemId>"}'
npm run gamctl -- org-test.run --admin --params '{"projectId":"<projectId>","workItemId":"<testerWorkItemId>"}'
npm run gamctl -- org-retry.list --admin --params '{"missionId":"<missionId>"}'
```

The daemon runs autonomy convergence every 15 seconds by default;
`GAM_AUTONOMY_POLL_MS` can change it between 5 seconds and 10 minutes.

## Limits and safety boundaries

- The browser extension can send and observe ChatGPT Web prompts/replies. **A
  normal ChatGPT Web conversation does not by itself have filesystem or terminal
  access.** The Worker must have a real, operator-approved way to write its
  worktree and invoke the scoped CLI for the system to produce code commits.
  This implementation does not invent such authority from model prose.
- Tests execute checked-in Node code locally. They are **not** a complete OS
  sandbox. Enable agent-initiated tests only for trusted projects and accounts.
- A general multi-branch merge candidate may differ from the exact verified
  claim SHA. Promotion currently fails closed in that case; rerun the appropriate
  integration/test/review process instead of bypassing evidence.
- Direct human Git modifications outside Charterion remain outside the
  application's security boundary. Protect the target branch using repository
  permissions and branch rules.
- GitHub Actions on a fork may require explicit enabling before CI appears.
- This architecture is intended for a controlled pilot, not unattended
  deployment on untrusted repositories.

## One-command regression check (Windows)

After the final pull, run once:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-organization.ps1
```

The command checks the full TypeScript control plane, targeted integration
tests, extension typechecks, full tests and builds. Inspect its first failing
command and report the error; do not suppress failing gates.
