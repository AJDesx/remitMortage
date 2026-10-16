#!/usr/bin/env python3
# Copyright (c) 2026 RemitMortgage Protocol Contributors
# SPDX-License-Identifier: MIT
"""Validate PodDisruptionBudgets and topology spread for k8s Deployments.

Every non-canary Deployment in devops/k8s with 2+ replicas must:
  * be selected by exactly one PodDisruptionBudget (two PDBs on one pod make
    the eviction API return 500), and that PDB must keep >= 1 pod available;
  * spread across zones and nodes via topologySpreadConstraints;
  * carry a podAntiAffinity term on kubernetes.io/hostname.

Usage: check-k8s-availability.py [manifest_dir]   (exit 1 on any violation)
See docs/POD_DISRUPTION_BUDGETS.md.
"""
import sys
from pathlib import Path

import yaml

ZONE = "topology.kubernetes.io/zone"
HOST = "kubernetes.io/hostname"


def load(directory):
    docs = []
    for f in sorted(Path(directory).glob("*.yaml")):
        for d in yaml.safe_load_all(f.read_text()):
            if isinstance(d, dict):
                docs.append((f.name, d))
    return docs


def selects(match_labels, pod_labels):
    return bool(match_labels) and all(pod_labels.get(k) == v for k, v in match_labels.items())


def check(docs):
    errors = []
    pdbs = [d for _, d in docs if d.get("kind") == "PodDisruptionBudget"]
    for fname, d in docs:
        if d.get("kind") != "Deployment":
            continue
        name = d["metadata"]["name"]
        if d["metadata"].get("labels", {}).get("track") == "canary":
            continue
        if d["spec"].get("replicas", 1) < 2:
            continue  # a PDB on a single replica would block every drain
        tpl = d["spec"]["template"]
        labels = tpl["metadata"].get("labels", {})
        spec = tpl["spec"]

        matching = [p for p in pdbs if selects(p["spec"].get("selector", {}).get("matchLabels", {}), labels)]
        if len(matching) != 1:
            errors.append(f"{fname}: Deployment '{name}' is selected by {len(matching)} PodDisruptionBudgets (need exactly 1)")
        for p in matching:
            ps = p["spec"]
            if "minAvailable" not in ps and "maxUnavailable" not in ps:
                errors.append(f"PDB '{p['metadata']['name']}' sets neither minAvailable nor maxUnavailable")
            if ps.get("minAvailable") in (0, "0", "0%") or ps.get("maxUnavailable") in ("100%",):
                errors.append(f"PDB '{p['metadata']['name']}' allows every pod to be evicted")

        keys = {c.get("topologyKey") for c in spec.get("topologySpreadConstraints", [])}
        for key in (ZONE, HOST):
            if key not in keys:
                errors.append(f"{fname}: Deployment '{name}' has no topologySpreadConstraint on {key}")
        anti = spec.get("affinity", {}).get("podAntiAffinity", {})
        terms = [t.get("podAffinityTerm", t) for t in anti.get("preferredDuringSchedulingIgnoredDuringExecution", [])]
        terms += anti.get("requiredDuringSchedulingIgnoredDuringExecution", [])
        if not any(t.get("topologyKey") == HOST for t in terms):
            errors.append(f"{fname}: Deployment '{name}' has no podAntiAffinity on {HOST}")
    return errors


def main():
    directory = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parent.parent / "devops/k8s")
    errors = check(load(directory))
    for e in errors:
        print(f"ERROR: {e}")
    if errors:
        return 1
    print("k8s availability checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
