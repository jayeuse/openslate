"""Bounded SSE connection checks using the actor's existing private cookie jar."""

import json
import time
from collections.abc import Callable, Mapping
from uuid import uuid4

import httpx

_MAX_BYTES = 16_384
_MAX_CHUNKS = 64
_SECONDS = 5.0


def check_event_stream(
    client: httpx.Client,
    origin: str,
    append: Callable[[Mapping[str, object]], None],
) -> dict[str, object]:
    # Imported at execution time because SampleClient exposes this helper.
    from operations.sample_client import SampleAuthenticationError, SampleClientError, _request_id

    attempt_id = str(uuid4())
    append(
        {
            "event": "request_started",
            "attempt_id": attempt_id,
            "method": "GET",
            "route_template": "/api/events",
        }
    )
    status_code: int | None = None
    request_id: str | None = None
    outcome = "protocol_error"
    try:
        with client.stream(
            "GET",
            "/api/events",
            headers={
                "Origin": origin,
                "Accept": "text/event-stream",
                "Sec-Fetch-Site": "same-origin",
            },
            timeout=httpx.Timeout(_SECONDS),
        ) as response:
            status_code, request_id = response.status_code, _request_id(response)
            if status_code == 401:
                raise SampleAuthenticationError(
                    "Event stream authorization was refused", status_code=401, request_id=request_id
                )
            if (
                status_code != 200
                or response.headers.get("content-type", "").partition(";")[0] != "text/event-stream"
            ):
                raise SampleClientError(
                    "Event stream did not return an authenticated SSE response",
                    status_code=status_code,
                    request_id=request_id,
                )
            buffer = b""
            size = 0
            deadline = time.monotonic() + _SECONDS
            for index, chunk in enumerate(response.iter_raw()):
                size += len(chunk)
                if size > _MAX_BYTES or index >= _MAX_CHUNKS or time.monotonic() > deadline:
                    break
                buffer += chunk
                buffer = buffer.replace(b"\r\n", b"\n")
                while b"\n\n" in buffer:
                    frame, buffer = buffer.split(b"\n\n", 1)
                    lines = frame.split(b"\n")
                    if all(not line or line.startswith(b":") for line in lines):
                        continue
                    if b"event: resync" in lines:
                        data = b"\n".join(
                            line.removeprefix(b"data: ")
                            for line in lines
                            if line.startswith(b"data: ")
                        )
                        try:
                            payload = json.loads(data)
                        except ValueError:
                            break
                        if payload == {}:
                            outcome = "resync_received"
                            return {"status_code": 200, "request_id": request_id, "resyncs": 1}
                    raise SampleClientError(
                        "Event stream did not send the expected initial resync",
                        status_code=status_code,
                        request_id=request_id,
                    )
            raise SampleClientError(
                "Event stream initial resync exceeded its safe read bound",
                status_code=status_code,
                request_id=request_id,
            )
    except httpx.HTTPError:
        outcome = "transport_error"
        raise SampleClientError(
            "Event stream check failed; no automatic reconnect was attempted",
            status_code=status_code,
            request_id=request_id,
        ) from None
    finally:
        append(
            {
                "event": "request_finished",
                "attempt_id": attempt_id,
                "status_code": status_code,
                "request_id": request_id,
                "outcome": outcome,
            }
        )
