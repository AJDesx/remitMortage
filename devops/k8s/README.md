# Kubernetes Autoscaling (HPA)

Manifests for running the RemitMortgage backend API on Kubernetes with CPU-based
horizontal pod autoscaling.

| File | Purpose |
| --- | --- |
| `backend-deployment.yaml` | Backend Deployment with CPU/memory requests, limits, ConfigMap, and secret environment mapping |
| `backend-service.yaml` | ClusterIP Service fronting the backend pods |
| `backend-configmap.yaml` | ConfigMap defining standard non-sensitive variables |
| `backend-ingress.yaml` | Ingress mapping external/internal APIs to the ClusterIP Service |
| `backend-canary-deployment.yaml` | Canary Deployment for releasing candidate images to isolated pod pool |
| `backend-canary-service.yaml` | ClusterIP Service fronting canary backend pods |
| `backend-canary-ingress.yaml` | Nginx Ingress annotations for weighted traffic splitting (5% / 25% / 100%) |
| `backend-hpa.yaml` | HorizontalPodAutoscaler: 2–10 replicas, scale at 80% CPU and 85% Memory |
| `frontend-deployment.yaml` | Frontend Deployment (zone/node spread, anti-affinity) |
| `pod-disruption-budgets.yaml` | PodDisruptionBudgets for backend (incl. in-process queue workers) and frontend — see [docs/POD_DISRUPTION_BUDGETS.md](../../docs/POD_DISRUPTION_BUDGETS.md) |
| `loadtest-job.yaml` | Job that generates mock request load to verify scale-up |
| `worker-scaledobject.yaml` | KEDA Redis queue-depth scaler for notifications, webhooks, and analytics |
| `policy/verify-image-signatures.yaml` | Kyverno admission policy for signed images and SPDX attestations |
| `anonymized-staging-seed-cronjob.yaml` | Weekly CronJob (staging cluster only) that refreshes the staging DB with an anonymized copy of production data — see [docs/DATA_ANONYMIZATION_PIPELINE.md](../../docs/DATA_ANONYMIZATION_PIPELINE.md) |

## Canary Deployment & Automated Traffic Ramp-Up (#457)

RemitMortgage utilizes Nginx Ingress weighted traffic splitting combined with automated health monitoring to safely release new backend versions.

### Ramp-Up Stages
1. **Stage 1 (5% Weight)**: Initial canary exposure. Ingress routes 5% of incoming live API requests to candidate pods. Hold window: 30s monitoring.
2. **Stage 2 (25% Weight)**: Mid-tier canary exposure. Ingress routes 25% of incoming traffic to candidate pods. Hold window: 60s monitoring.
3. **Stage 3 (100% Promotion)**: Complete verification. Canary image is promoted to the primary deployment, canary traffic weight is reset to 0%, and canary replicas are safely scaled down.

### Automated Rollback Thresholds
Traffic ramp-up is orchestrated via `scripts/canary-ramp.sh`. The script performs HTTP `/health` probes and error rate checks every 2 seconds. Immediate **AUTO-ROLLBACK** is triggered if any of the following occur:
- **Health Check Failure**: `/health` endpoint returns non-200 HTTP status code.
- **Error Spike**: 5xx HTTP response rate exceeds 1% of sample window.
- **Latency Anomaly**: P99 response latency exceeds 500ms.

On rollback:
- Ingress `canary-weight` is immediately set to `0`.
- Canary deployment replicas are scaled to `0`.
- Primary stable deployment handles 100% of user traffic uninterrupted.

### Running Canary Ramp-Up Automation
```bash
./scripts/canary-ramp.sh
```

## Queue worker autoscaling

Install KEDA before applying `worker-scaledobject.yaml`. The scaler watches the
BullMQ `wait` list for each worker queue, scales from 2 to 20 replicas, and
keeps five minutes of scale-down stabilization so a drained queue does not
cause replica thrashing.

```bash
kubectl apply -f https://github.com/kedacore/keda/releases/latest/download/keda-2.16.1.yaml
kubectl apply -f devops/k8s/worker-scaledobject.yaml
kubectl get scaledobject remitmortgage-workers
```

Build a backlog with the existing webhook or analytics load test and verify
`kubectl get hpa -l app.kubernetes.io/managed-by=keda --watch` grows replicas;
stop the producer and verify they return to two after the cooldown window.

## Prerequisites

The HPA reads pod CPU/memory from the metrics API, so `metrics-server` must be running:

```bash
kubectl get deployment metrics-server -n kube-system
# if missing:
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

Before applying, ensure the backend secrets exist:
```bash
kubectl create secret generic remitmortgage-backend-secrets \
  --from-literal=database-url="postgres://..." \
  --from-literal=redis-url="redis://..." \
  --from-literal=redis-cluster-nodes="..." \
  --from-literal=otel-exporter-otlp-endpoint="http://jaeger-collector:4318"
```

CPU **requests** are required on the Deployment — utilization is a percentage of
the request, and an HPA targeting a pod without one reports `<unknown>`.

## Dry-run Validation

You can validate the manifests syntax before deploying using `kubectl`:

```bash
kubectl apply --dry-run=client -f devops/k8s/
```

## Deploy

```bash
kubectl apply -f devops/k8s/backend-configmap.yaml
kubectl apply -f devops/k8s/backend-deployment.yaml
kubectl apply -f devops/k8s/backend-service.yaml
kubectl apply -f devops/k8s/backend-ingress.yaml
kubectl apply -f devops/k8s/backend-hpa.yaml
```

## Policy

- **Target**: 80% average CPU utilization (secondary: 85% memory)
- **Replicas**: min 2, max 10
- **Scale up**: 30s stabilization, up to +100% or +4 pods per 30s
- **Scale down**: 300s stabilization, at most 1 pod per 60s

The asymmetric stabilization windows mean traffic spikes are absorbed quickly
while capacity is released slowly, avoiding replica thrash on bursty load.

## Verify autoscaling

Watch the HPA in one terminal:

```bash
kubectl get hpa remitmortgage-backend --watch
```

Generate load in another:

```bash
kubectl apply -f devops/k8s/loadtest-job.yaml
```

Expected: `TARGETS` climbs past `80%/80%` and `REPLICAS` grows toward 10.
Confirm the new pods:

```bash
kubectl get pods -l app=remitmortgage-backend
kubectl describe hpa remitmortgage-backend   # shows SuccessfulRescale events
```

Then remove the load and confirm scale-down:

```bash
kubectl delete job backend-loadtest
```

Replicas return to `minReplicas: 2` after the 300s scale-down stabilization
window, one pod per minute.
