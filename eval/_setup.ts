// Deterministic tests never load application credentials. Live evaluations have
// a separate explicit configuration; EVAL_LIVE inherited by a shell is rejected.
if (process.env.EVAL_LIVE === "1") {
  throw new Error("Live evaluations are forbidden in the deterministic harness")
}
import { installNetworkGuard } from "./_network-guard"
installNetworkGuard()
