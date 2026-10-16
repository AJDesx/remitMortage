# Pod Disruption Budgets & Topology Spread (#836)

A node drain or zone issue must never take every replica of a service down at
once. Two mechanisms enforce this:

| Mechanism | Where | Effect |
| --- | --- | --- |
| `PodDisruptionBudget` | `devops/k8s/pod-disruption-budgets.yaml` | Evictions (drain, upgrade, autoscaler scale-down) are refused if they would leave fewer than 50% of replicas (rounded up) available. 2 replicas → 1, 10 → 5. |
| `topologySpreadConstraints` | each Deployment | Zone spread is **hard** (`DoNotSchedule`, `maxSkew: 1`); node spread is soft (`ScheduleAnyway`) so a small cluster can still schedule. |
| `podAntiAffinity` | each Deployment | Prefers (weight 100) not co-locating two replicas on one node. |

## Coverage

| Workload | Deployment | PDB |
| --- | --- | --- |
| Backend API | `backend-deployment.yaml` | `remitmortgage-backend` |
| Frontend | `frontend-deployment.yaml` | `remitmortgage-frontend` |
| Queue workers | run inside the backend pods and are scaled by KEDA (`worker-scaledobject.yaml`) | covered by `remitmortgage-backend` |

The workers share pods with the API, so they share its PDB. Adding a second PDB
for the same pods would make the eviction API return HTTP 500, so CI rejects
that. If the workers are split into their own Deployment, give it its own
labels and PDB — `scripts/check-k8s-availability.py` will require it.

Excluded on purpose: the canary Deployment (`track: canary`, throwaway) and
single-replica Deployments such as ClamAV (a PDB there would block every drain).
Both rules live in the validator.

## CI validation

The `k8s-manifest-validation` job in `.github/workflows/ci.yml` runs
`scripts/check-k8s-availability.py devops/k8s`, which fails when a Deployment
with 2+ replicas has no PDB (or more than one), a PDB that permits evicting
every pod, or no zone/node spread or anti-affinity. Its unit tests are in
`scripts/test_check_k8s_availability.py`.

## Drain test (staging)

```bash
kubectl config use-context <staging>
scripts/pdb-drain-test.sh <node-name>
```

The script refuses to run outside a staging context, cordons and drains the
node, polls every PDB every 2s, and fails if any PDB's `currentHealthy` drops
below `desiredHealthy`. Blocked evictions are retried by `kubectl drain`;
that is the PDB doing its job.

### Results

| Date | Cluster / node | Result | Notes |
| --- | --- | --- | --- |
| _pending_ | staging | _not yet run_ | The drain test needs access to the staging cluster and has not been executed from this change. Run it and record the outcome, pod placement before/after, and any blocked evictions here. |

## Gotchas

- With `maxSkew: 1` and `DoNotSchedule` on zones, a zone with no schedulable
  capacity leaves pods `Pending` rather than stacking them in another zone.
  Keep spare capacity in every zone.
- A PDB only protects against *voluntary* disruption; node crashes ignore it.
- `minAvailable: 50%` with a single replica rounds up to 1 and blocks the drain
  entirely; keep both services at 2+ replicas.
