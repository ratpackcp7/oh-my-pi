# Recoverable eval-runtime overlay.
# Loaded after prelude.py so it can reuse the stable bridge/helper primitives
# without modifying the large base prelude for this narrow repair.

_omp_parallel_last_status = None


class ParallelFailure(RuntimeError):
    """One or more parallel() siblings failed after the whole wave settled."""

    def __init__(self, completed_indices, failed_indices):
        self.completed_indices = tuple(completed_indices)
        self.failed_indices = tuple(failed_indices)
        super().__init__(
            "parallel() failed for indices "
            f"{list(self.failed_indices)}; completed indices "
            f"{list(self.completed_indices)} are preserved in parallel.last(); "
            "retry only failed indices"
        )


def _parallel_last():
    """Return an idempotent snapshot of the most recently settled parallel wave."""
    status = _omp_parallel_last_status
    if status is None:
        return None
    return {
        "status": status["status"],
        "results": _AwaitableList(status["results"]),
        "completed_indices": list(status["completed_indices"]),
        "failed_indices": list(status["failed_indices"]),
        "errors": dict(status["errors"]),
    }


def _recoverable_parallel(thunks):
    """Run all thunks, preserve every settled outcome, then report failures."""
    global _omp_parallel_last_status

    import concurrent.futures
    import contextvars

    thunks = list(thunks)
    for thunk in thunks:
        if not callable(thunk):
            raise TypeError("parallel() expects an iterable of zero-arg callables")

    if not thunks:
        results = _AwaitableList()
        _omp_parallel_last_status = {
            "status": "completed",
            "results": results,
            "completed_indices": [],
            "failed_indices": [],
            "errors": {},
        }
        return results

    limit = _concurrency_limit()
    workers = min(limit, len(thunks)) if limit > 0 else len(thunks)
    results = _AwaitableList(None for _ in thunks)
    errors = {}

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {}
        for index, thunk in enumerate(thunks):
            ctx = contextvars.copy_context()
            futures[pool.submit(ctx.run, thunk)] = index
        for future in concurrent.futures.as_completed(futures):
            index = futures[future]
            try:
                results[index] = future.result()
            except BaseException as exc:  # noqa: BLE001 - preserve sibling failures for caller
                errors[index] = exc

    failed_indices = sorted(errors)
    completed_indices = [index for index in range(len(thunks)) if index not in errors]
    _omp_parallel_last_status = {
        "status": "failed" if failed_indices else "completed",
        "results": results,
        "completed_indices": completed_indices,
        "failed_indices": failed_indices,
        "errors": {
            index: f"{type(errors[index]).__name__}: {errors[index]}"
            for index in failed_indices
        },
    }

    if failed_indices:
        primary = errors[failed_indices[0]]
        raise ParallelFailure(completed_indices, failed_indices) from primary
    return results


parallel = _recoverable_parallel
parallel.last = _parallel_last


def _runtime_agent(
    prompt,
    agent=None,
    model=None,
    *,
    label=None,
    schema=None,
    schema_mode=None,
    isolated=None,
    apply=None,
    merge=None,
    handle=False,
):
    """agent() compatibility wrapper that retains host-owned runtime identity on handles."""
    args = {"prompt": prompt}
    if agent is not None:
        args["agent"] = agent
    if model is not None:
        args["model"] = model
    if label is not None:
        args["label"] = label
    if schema is not None:
        args["schema"] = schema
    if schema_mode is not None:
        args["schemaMode"] = schema_mode
    if isolated is not None:
        args["isolated"] = bool(isolated)
    if apply is not None:
        args["apply"] = bool(apply)
    if merge is not None:
        args["merge"] = bool(merge)
    if handle:
        args["handle"] = True

    res = _bridge_call("__agent__", args)
    text = res.get("text") if isinstance(res, dict) else res
    has_data = isinstance(res, dict) and "data" in res
    parsed = res["data"] if has_data else json.loads(text) if schema is not None else text
    if not handle:
        return parsed

    details = res.get("details") if isinstance(res, dict) else None
    if not isinstance(details, dict) or details.get("id") is None:
        return {
            "text": text,
            "output": text,
            "handle": None,
            "id": None,
            "agent": None,
        }

    node = {
        "text": text,
        "output": text,
        "handle": f"agent://{details['id']}",
        "id": details["id"],
        "agent": details.get("agent"),
    }
    if has_data or schema is not None:
        node["data"] = parsed
    for src_key, dst_key in (
        ("isolated", "isolated"),
        ("patchPath", "patch_path"),
        ("branchName", "branch_name"),
        ("nestedPatches", "nested_patches"),
        ("changesApplied", "changes_applied"),
        ("isolationSummary", "isolation_summary"),
        ("runtime_parent_provider", "runtime_parent_provider"),
        ("runtime_parent_model", "runtime_parent_model"),
        ("runtime_parent_usage_pool", "runtime_parent_usage_pool"),
        ("runtime_child_requested_model", "runtime_child_requested_model"),
        ("runtime_child_resolved_provider", "runtime_child_resolved_provider"),
        ("runtime_child_resolved_model", "runtime_child_resolved_model"),
        ("runtime_fallback_used", "runtime_fallback_used"),
    ):
        if src_key in details:
            node[dst_key] = details[src_key]
    return node


agent = _runtime_agent
