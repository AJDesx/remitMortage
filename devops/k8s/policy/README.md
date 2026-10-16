# Deployment Supply-Chain Policy

Kyverno verifies that every RemitMortgage image admitted in the `remitmortgage`
namespace is signed by the pinned GitHub Actions workflow and carries its SPDX
SBOM attestation. Unsigned images, unknown identities, mutable tags, and images
whose digest changes are rejected.

```bash
kubectl apply -f devops/k8s/policy/verify-image-signatures.yaml
kubectl apply -f devops/k8s/backend-deployment.yaml --server-side
```

The signed-image workflow is the only trusted identity. To test rejection,
deploy an unsigned digest from `public.ecr.aws/remitmortgage` and inspect the
Kyverno admission response. A signed release digest should be admitted.

## Time-limited exception

Exceptions require an incident ticket, an owner, and an expiry timestamp. The
cluster administrator creates a narrowly scoped `PolicyException` and removes
it when the expiry is reached; exceptions are never granted by changing the
ClusterPolicy to audit mode.

```yaml
apiVersion: kyverno.io/v2
kind: PolicyException
metadata:
  name: incident-1234-image-exception
  namespace: remitmortgage
  labels:
    expires-at: "2026-10-20T00:00:00Z"
    owner: platform-oncall
spec:
  exceptions:
    - policyName: verify-remitmortgage-images
      ruleNames: [verify-github-signed-images]
  match:
    any:
      - resources:
          kinds: [Pod]
          names: [remitmortgage-backend-*]
```

Review the exception list daily and delete expired exceptions:

```bash
kubectl get policyexception -n remitmortgage -o yaml
kubectl delete policyexception incident-1234-image-exception -n remitmortgage
```