#!/usr/bin/env python3
"""Validate the planning bundle, not the unimplemented product runtime."""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import re
import sys
from typing import Any, Callable
from urllib.parse import unquote

import yaml
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
FILES = {
    "profiles": "profiles.example.yaml",
    "roles": "roles.yaml",
    "workflows": "workflows.yaml",
    "policies": "policies.yaml",
    "project": "project.example.yaml",
    "execution-result": "result.example.json",
    "task-request": "task-request.example.json",
}
ROLES = {"coordinator", "architect", "developer", "reviewer"}

class BundleError(ValueError):
    pass

class UniqueKeyLoader(yaml.SafeLoader):
    pass

def unique_mapping(loader: UniqueKeyLoader, node: yaml.MappingNode, deep: bool = False) -> dict:
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            exists = key in result
        except TypeError as exc:
            raise BundleError("Non-scalar YAML key") from exc
        if exists:
            raise BundleError(f"Duplicate YAML key: {key}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result

UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping
)

def read_data(path: Path) -> Any:
    text = path.read_text(encoding="utf-8")
    if len(text.encode("utf-8")) > 2_000_000:
        raise BundleError(f"Input too large: {path.name}")
    if path.suffix == ".json":
        def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict:
            out = {}
            for key, value in pairs:
                if key in out:
                    raise BundleError(f"Duplicate JSON key: {key}")
                out[key] = value
            return out
        return json.loads(text, object_pairs_hook=reject_duplicates)
    # This bundle deliberately does not use YAML aliases/merge keys.
    if any(isinstance(t, yaml.tokens.AliasToken) for t in yaml.scan(text)):
        raise BundleError(f"YAML aliases are not allowed: {path.name}")
    return yaml.load(text, Loader=UniqueKeyLoader)

def load_bundle() -> tuple[dict[str, Any], dict[str, Any]]:
    configs = {k: read_data(ROOT/"config"/p) for k, p in FILES.items()}
    schemas = {k: read_data(ROOT/"schemas"/f"{k}.schema.json") for k in FILES}
    for item in schemas.values():
        Draft202012Validator.check_schema(item)
    return configs, schemas

def graph_depth(nodes: list[dict[str, Any]], limit: int) -> int:
    by_id = {node["id"]: node for node in nodes}
    if len(by_id) != len(nodes):
        raise BundleError("Duplicate node ID")
    visiting: set[str] = set()
    depths: dict[str, int] = {}

    def visit(node_id: str) -> int:
        if node_id not in by_id:
            raise BundleError(f"Unknown dependency: {node_id}")
        if node_id in visiting:
            raise BundleError(f"Cycle detected at {node_id}")
        if node_id in depths:
            return depths[node_id]
        visiting.add(node_id)
        depth = 1 + max((visit(dep) for dep in by_id[node_id]["dependencies"]), default=0)
        visiting.remove(node_id)
        if depth > limit:
            raise BundleError("Dependency depth budget exceeded")
        depths[node_id] = depth
        return depth

    return max((visit(node_id) for node_id in by_id), default=0)

def validate(configs: dict[str, Any], schemas: dict[str, Any]) -> None:
    for kind, content in configs.items():
        errors = sorted(Draft202012Validator(schemas[kind]).iter_errors(content),
                        key=lambda error: str(error.path))
        if errors:
            error = errors[0]
            path = "/".join(map(str, error.path)) or "<root>"
            raise BundleError(f"{kind}/{path}: {error.message}")
    profiles = configs["profiles"]["profiles"]
    profile_map = {p["id"]: p for p in profiles}
    if len(profile_map) != len(profiles):
        raise BundleError("Duplicate Profile ID")
    project = configs["project"]
    roles = configs["roles"]["roles"]
    policy = configs["policies"]
    for role, binding in roles.items():
        if binding["profileId"] not in profile_map:
            raise BundleError(f"Unknown Profile for {role}")
        profile = profile_map[binding["profileId"]]
        if profile["executionTarget"] != project["executionTarget"]:
            raise BundleError("Profile and Project execution targets do not match")
        perms = policy["rolePermissions"][role]
        if binding["canCreateSubtasks"] and "dag.propose" not in perms:
            raise BundleError(f"{role} needs dag.propose for subtask creation")
        if role != "developer" and "repo.write" in perms:
            raise BundleError(f"v1 role is source-read-only: {role}")
    workflows = configs["workflows"]["workflows"]
    workflow_ids = [workflow["id"] for workflow in workflows]
    if len(set(workflow_ids)) != len(workflow_ids):
        raise BundleError("Duplicate workflow ID")
    if project["workflowId"] not in workflow_ids:
        raise BundleError("Unknown project workflow")
    if configs["task-request"]["workflowId"] not in workflow_ids:
        raise BundleError("Unknown requested workflow")
    for workflow in workflows:
        nodes = workflow["nodes"]
        if len(nodes) > policy["limits"]["maxNodesPerRun"]:
            raise BundleError("Node count budget exceeded")
        if len(nodes) > policy["limits"]["maxExecutionsPerRun"]:
            raise BundleError("Execution budget cannot run the static graph")
        graph_depth(nodes, policy["limits"]["maxDependencyDepth"])
    result = configs["execution-result"]
    if "review" in result:
        artifact_ids = {a["id"] for a in result["artifactRefs"]}
        if not set(result["review"]["evidenceRefs"]).issubset(artifact_ids):
            raise BundleError("Review example references missing evidence artifacts")

def markdown_anchors(text: str) -> set[str]:
    anchors: set[str] = set()
    counts: dict[str, int] = {}
    for heading in re.findall(r"^#{1,6}\s+(.+?)\s*#*\s*$", text, flags=re.M):
        slug = re.sub(r"[^\w\s-]", "", heading.lower())
        slug = re.sub(r"\s", "-", slug)
        count = counts.get(slug, 0)
        counts[slug] = count + 1
        anchors.add(f"{slug}-{count}" if count else slug)
    return anchors

def check_links() -> int:
    checked = 0
    for path in ROOT.rglob("*.md"):
        text = re.sub(r"```.*?```", "", path.read_text(encoding="utf-8"), flags=re.S)
        for href in re.findall(r"(?<!!)\[[^\]]*\]\(([^)\s]+)\)", text):
            if "://" in href or href.startswith("mailto:"):
                continue
            file_part, _, anchor = unquote(href).partition("#")
            target = (path.parent/file_part).resolve() if file_part else path
            if not target.is_relative_to(ROOT):
                raise BundleError(f"Link escapes bundle: {path.name}: {href}")
            if not target.exists():
                raise BundleError(f"Broken local link: {path.relative_to(ROOT)}: {href}")
            if anchor and target.suffix == ".md":
                if anchor not in markdown_anchors(target.read_text(encoding="utf-8")):
                    raise BundleError(f"Unknown anchor: {path.relative_to(ROOT)}: {href}")
            checked += 1
    return checked

def check_backlog() -> int:
    data = read_data(ROOT/"project"/"backlog.json")
    issues = data["issues"]
    known = {issue["id"] for issue in issues}
    if len(known) != len(issues):
        raise BundleError("Duplicate backlog ID")
    acceptance_text = (ROOT/"docs"/"ACCEPTANCE.md").read_text(encoding="utf-8")
    acceptance_ids = set(re.findall(r"\bA\d{2}\b", acceptance_text))
    for issue in issues:
        if issue["suggestedRole"] not in ROLES or issue["status"] != "planned":
            raise BundleError("Invalid backlog role or state")
        if not set(issue["dependencies"]).issubset(known):
            raise BundleError(f"Unknown backlog dependency: {issue['id']}")
        if not set(issue["acceptanceIds"]).issubset(acceptance_ids):
            raise BundleError(f"Unknown acceptance ID: {issue['id']}")
    graph_depth([{"id":i["id"], "dependencies":i["dependencies"]} for i in issues], 1000)
    return len(issues)

def self_test(configs: dict[str, Any], schemas: dict[str, Any]) -> list[str]:
    passed: list[str] = []
    def reject(name: str, change: Callable[[dict[str, Any]], Any]) -> None:
        bad = copy.deepcopy(configs)
        change(bad)
        try:
            validate(bad, schemas)
        except BundleError:
            passed.append(name)
        else:
            raise BundleError(f"Negative test unexpectedly accepted: {name}")
    def node(c: dict[str, Any]) -> dict[str, Any]:
        return c["workflows"]["workflows"][0]["nodes"][2]
    def workflow(c: dict[str, Any]) -> dict[str, Any]:
        return c["workflows"]["workflows"][0]

    reject("node_profile_override", lambda c: node(c).update(profileId="claude-main"))
    reject("node_model_override", lambda c: node(c).update(model="arbitrary-model"))
    reject("node_profiles_array", lambda c: node(c).update(profiles=["claude-main"]))
    reject("workflow_profile_override", lambda c: workflow(c).update(profileId="claude-main"))
    reject("workflow_catalog_model_override", lambda c: c["workflows"].update(model="x"))
    reject("task_profile_override", lambda c: c["task-request"].update(profileId="claude-main"))
    reject("task_model_override", lambda c: c["task-request"].update(model="x"))
    reject("role_multiselect", lambda c: c["roles"]["roles"]["developer"].update(profileId=["codex-main"]))
    reject("unknown_role", lambda c: c["roles"]["roles"].update(tester={"profileId":"codex-main","canCreateSubtasks":False}))
    reject("missing_role", lambda c: c["roles"]["roles"].pop("reviewer"))
    reject("unknown_profile", lambda c: c["roles"]["roles"]["developer"].update(profileId="absent"))
    reject("duplicate_profile", lambda c: c["profiles"]["profiles"].append(copy.deepcopy(c["profiles"]["profiles"][0])))
    reject("implicit_profile_fallback", lambda c: c["profiles"]["profiles"][0].update(fallbackProfileId="codex-main"))
    reject("args_model_override", lambda c: c["profiles"]["profiles"][0].update(extraArgs=["--model","x"]))
    reject("args_skip_permissions", lambda c: c["profiles"]["profiles"][0].update(extraArgs=["--dangerously-skip-permissions"]))
    reject("cycle", lambda c: workflow(c)["nodes"][0].update(dependencies=["review"]))
    reject("self_dependency", lambda c: node(c).update(dependencies=["frontend"]))
    reject("unknown_dependency", lambda c: node(c).update(dependencies=["absent"]))
    reject("duplicate_node", lambda c: workflow(c)["nodes"].append(copy.deepcopy(node(c))))
    reject("duplicate_workflow", lambda c: c["workflows"]["workflows"].append(copy.deepcopy(workflow(c))))
    reject("node_budget", lambda c: c["policies"]["limits"].update(maxNodesPerRun=2))
    reject("depth_budget", lambda c: c["policies"]["limits"].update(maxDependencyDepth=1))
    reject("negative_concurrency", lambda c: c["policies"]["concurrency"].update(globalMax=-1))
    reject("zero_attempts", lambda c: c["policies"]["limits"].update(maxAttempts=0))
    reject("unauthenticated_local_api", lambda c: c["policies"]["security"].update(requireLocalApiAuth=False))
    reject("allow_unknown_capabilities", lambda c: c["policies"]["security"].update(unknownRequiredCapability="allow"))
    reject("unmanaged_native_delegation", lambda c: c["policies"]["security"].update(allowUnmanagedNativeDelegation=True))
    reject("agent_rule_promotion", lambda c: c["policies"]["security"].update(projectRulePromotion="agent"))
    reject("reviewer_source_write", lambda c: c["policies"]["rolePermissions"]["reviewer"].append("repo.write"))
    reject("subtask_permission_mismatch", lambda c: c["policies"]["rolePermissions"]["coordinator"].remove("dag.propose"))
    reject("mixed_execution_targets", lambda c: c["project"].update(executionTarget="wsl"))
    reject("fact_without_evidence", lambda c: c["execution-result"]["memoryProposals"].append({"type":"fact","content":"Claim","evidenceRefs":[]}))
    reject("unknown_result_approval", lambda c: c["execution-result"].update(approved=True))
    reject("missing_review_evidence", lambda c: c["execution-result"]["review"].update(evidenceRefs=["missing"]))
    reject("unknown_requested_workflow", lambda c: c["task-request"].update(workflowId="missing"))
    try:
        yaml.load("id: first\nid: second\n", Loader=UniqueKeyLoader)
    except BundleError:
        passed.append("duplicate_yaml_key")
    else:
        raise BundleError("Duplicate YAML key unexpectedly accepted")
    # Open model ID means schema accepts it, not that any CLI/provider supports it.
    open_model = copy.deepcopy(configs)
    open_model["profiles"]["profiles"][0]["model"] = "provider/user-selected-model"
    validate(open_model, schemas)
    passed.append("open_model_id_is_configurable")
    return passed

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--json-output", type=Path)
    args = parser.parse_args()
    try:
        configs, schemas = load_bundle()
        validate(configs, schemas)
        links = check_links()
        backlog_count = check_backlog()
        tests = self_test(configs, schemas) if args.self_test else []
        for path in ROOT.rglob("*.yml"):
            read_data(path)
        report = {
            "status": "passed",
            "scope": "planning-bundle-static-validation-only",
            "schemas": len(schemas),
            "configExamples": len(configs),
            "localLinksChecked": links,
            "backlogItems": backlog_count,
            "selfTestsPassed": len(tests),
            "selfTestNames": tests,
            "realCliTestsExecuted": False,
            "productRuntimeTestsExecuted": False,
        }
        if args.json_output:
            args.json_output.parent.mkdir(parents=True, exist_ok=True)
            args.json_output.write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
        print(json.dumps(report, indent=2))
        return 0
    except (BundleError, yaml.YAMLError, OSError, ValueError) as error:
        print(f"Validation failed: {error}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
