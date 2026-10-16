# Runtime Threat Detection with Falco (#833)

Falco watches syscalls on every node and alerts on suspicious behavior inside
RemitMortgage containers, such as a shell appearing in a production pod.

| File | Purpose |
| --- | --- |
| `devops/falco/values.yaml` | Helm values: modern eBPF driver, JSON output, falcosidekick → Alertmanager |
| `devops/falco/rules.yaml` | The three custom rules |
| `devops/falco/exceptions.yaml` | Known-benign exceptions (append-only) |
| `devops/prometheus/alertmanager.yml` | `source: falco` routes (critical pages, the rest goes to Slack) |
| `scripts/falco-simulate.sh` | Triggers every rule in staging and checks Falco logged it |
| `.github/workflows/falco-rules.yml` | CI: `falco -V` rule validation + `amtool` routing test |

## Deploy

```bash
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm upgrade --install falco falcosecurity/falco -n falco --create-namespace \
  --version 4.8.0 -f devops/falco/values.yaml \
  --set-file customRules."rules\.yaml"=devops/falco/rules.yaml \
  --set-file customRules."exceptions\.yaml"=devops/falco/exceptions.yaml
```

Roll out to staging first and run the simulation before production.

## Rules

All rules are scoped to containers in the `remitmortgage` namespace.

| Rule | Priority | Fires when | Alert |
| --- | --- | --- | --- |
| Shell Spawned in RemitMortgage Production Container | CRITICAL | a shell process starts with a TTY (`kubectl exec -it`, reverse shell) | pages on-call |
| Sensitive File Read in RemitMortgage Container | CRITICAL | a process opens `/etc/shadow`, `/etc/sudoers`, SSH keys or the service-account token (Node reading the token is excluded) | pages on-call |
| Unexpected Outbound Connection from RemitMortgage Container | ERROR | a connection to a public IP on a port other than 53/80/443/5432/6379 | Slack `#ops-alerts` |

Non-interactive shells (no TTY, e.g. a health-check `sh -c`) do not match the
shell rule, which is the main source of benign noise.

## Alert routing

falcosidekick posts to Alertmanager with `source=falco` and a `severity` label
(CRITICAL→`critical`, ERROR/WARNING→`warning`). In `alertmanager.yml`:

- `source=falco, severity=critical` → PagerDuty (and Slack)
- any other `source=falco` → Slack only

Known-benign activity is suppressed at the source (Falco exceptions), so it
never reaches Alertmanager and never pages.

## Adding an exception

1. Confirm the activity is legitimate with the service owner.
2. Add an entry to `devops/falco/exceptions.yaml` for the rule, using that rule's
   exception name and field order:

   | Rule | Exception name | Fields (in order) | Comparators |
   | --- | --- | --- | --- |
   | Shell Spawned… | `known_benign_shell` | `k8s.ns.name`, `k8s.pod.name` | `=`, `startswith` |
   | Unexpected Outbound… | `known_benign_egress` | `container.image.repository`, `fd.sip` | `=`, `=` |
   | Sensitive File Read… | `known_benign_file_read` | `proc.name`, `fd.name` | `=`, `=` |

   ```yaml
   - rule: Shell Spawned in RemitMortgage Production Container
     exceptions:
       - name: known_benign_shell
         values:
           - [remitmortgage, remitmortgage-debug-]   # owner: platform, reason: kubectl debug
     append: true
   ```
3. Keep it as narrow as possible (specific image + IP, not a whole namespace),
   add a comment with owner/reason/expiry, and get a security review on the PR.
4. CI validates the file with Falco; after merge, re-run the `helm upgrade`.

## Verify detection

```bash
kubectl config use-context <staging>
scripts/falco-simulate.sh            # exits non-zero if any rule did not fire
```

Opening a shell with `kubectl -n remitmortgage exec -it <pod> -- sh` must raise
the CRITICAL alert and page on-call (use the PagerDuty test service in staging).

### Simulation results

| Date | Cluster | Shell | Sensitive read | Outbound | Notes |
| --- | --- | --- | --- | --- | --- |
| _pending_ | staging | — | — | — | Not yet run: needs a staging cluster with Falco deployed. The rules were YAML-checked but not yet loaded by Falco itself (CI does this via `falco -V`). Record results here after the first rollout. |
