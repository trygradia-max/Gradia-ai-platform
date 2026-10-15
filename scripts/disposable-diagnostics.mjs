// CLI output can include generated credentials. Return only fixed diagnostic labels.
export function disposableFailureSummary(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase()
  const patterns = {
    timeout: /timeout|timed out|deadline exceeded/,
    image_pull: /pull.*image|failed to pull|pull access denied|manifest unknown/,
    registry_rate_limit: /toomanyrequests|rate limit/,
    unhealthy: /unhealthy|health check.*fail|not ready/,
    docker_unavailable: /cannot connect to.*docker|docker daemon.*not running/,
    migration: /error.*sqlstate|migration.*fail/,
    disk_full: /no space left/,
    out_of_memory: /out of memory|oomkilled/,
  }
  return { exitCode: Number.isInteger(result.status) ? result.status : null,
    categories: Object.entries(patterns).filter(([,pattern]) => pattern.test(output)).map(([label]) => label) }
}
