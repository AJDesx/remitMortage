# Copyright (c) 2026 RemitMortgage Protocol Contributors
# SPDX-License-Identifier: MIT
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("chk", Path(__file__).with_name("check-k8s-availability.py"))
chk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chk)

K8S = Path(__file__).resolve().parent.parent / "devops/k8s"


def deployment(labels=None, spread=True, anti=True, extra_meta=None, replicas=2):
    labels = labels or {"app": "x"}
    pod = {"containers": []}
    if spread:
        pod["topologySpreadConstraints"] = [{"topologyKey": chk.ZONE}, {"topologyKey": chk.HOST}]
    if anti:
        pod["affinity"] = {"podAntiAffinity": {"preferredDuringSchedulingIgnoredDuringExecution": [
            {"weight": 1, "podAffinityTerm": {"topologyKey": chk.HOST}}]}}
    meta = {"name": "x", **(extra_meta or {})}
    return ("d.yaml", {"kind": "Deployment", "metadata": meta, "spec": {"replicas": replicas, "template": {"metadata": {"labels": labels}, "spec": pod}}})


def pdb(match=None, **spec):
    return ("p.yaml", {"kind": "PodDisruptionBudget", "metadata": {"name": "p"},
                       "spec": {"selector": {"matchLabels": match or {"app": "x"}}, **spec}})


class AvailabilityChecks(unittest.TestCase):
    def test_repo_manifests_pass(self):
        self.assertEqual(chk.check(chk.load(K8S)), [])

    def test_valid(self):
        self.assertEqual(chk.check([deployment(), pdb(minAvailable="50%")]), [])

    def test_missing_pdb(self):
        self.assertTrue(any("0 PodDisruptionBudgets" in e for e in chk.check([deployment()])))

    def test_duplicate_pdb(self):
        self.assertTrue(any("2 PodDisruptionBudgets" in e for e in chk.check([deployment(), pdb(minAvailable=1), pdb(minAvailable=1)])))

    def test_pdb_allows_all_evictions(self):
        self.assertTrue(any("every pod" in e for e in chk.check([deployment(), pdb(minAvailable=0)])))

    def test_missing_spread_and_anti_affinity(self):
        errs = chk.check([deployment(spread=False, anti=False), pdb(minAvailable=1)])
        self.assertEqual(len(errs), 3)

    def test_single_replica_skipped(self):
        self.assertEqual(chk.check([deployment(spread=False, anti=False, replicas=1)]), [])

    def test_canary_skipped(self):
        self.assertEqual(chk.check([deployment(spread=False, anti=False, extra_meta={"labels": {"track": "canary"}})]), [])


if __name__ == "__main__":
    unittest.main()
