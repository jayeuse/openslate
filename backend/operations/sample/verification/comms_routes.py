"""Implemented Comms endpoints with API-only sample executors; no future route placeholders."""

COMMS_ROUTES = frozenset(
    {
        ("GET", "/api/comms/templates"),
        ("POST", "/api/comms/templates"),
        ("GET", "/api/comms/templates/{template_id}"),
        ("PUT", "/api/comms/templates/{template_id}"),
        ("POST", "/api/comms/templates/{template_id}/application-preview"),
        ("POST", "/api/comms/templates/{template_id}/applications"),
        *(
            (method, "/api/comms/settings/" + scope + suffix)
            for scope in ("workspace", "category/{category_id}", "channel/{conversation_id}")
            for method, suffix in (
                ("GET", "/history"),
                ("GET", "/history/{history_id}"),
                ("POST", "/restoration-preview"),
                ("POST", "/restoration"),
            )
        ),
        ("GET", "/api/comms/direct-candidates"),
        ("GET", "/api/comms/scheduled-messages"),
        ("POST", "/api/comms/scheduled-messages"),
        ("GET", "/api/comms/scheduled-messages/{schedule_id}"),
        ("PUT", "/api/comms/scheduled-messages/{schedule_id}"),
        ("POST", "/api/comms/scheduled-messages/{schedule_id}/send"),
        ("POST", "/api/comms/scheduled-messages/{schedule_id}/cancellation"),
        ("GET", "/api/comms/retention"),
        ("PUT", "/api/comms/retention"),
        ("POST", "/api/comms/retention/preview"),
        ("GET", "/api/comms/exports"),
        ("POST", "/api/comms/exports"),
        ("GET", "/api/comms/exports/{export_id}"),
        ("GET", "/api/comms/exports/{export_id}/content"),
        ("GET", "/api/comms/search"),
        ("POST", "/api/realtime/token"),
        ("POST", "/api/comms/conversations/{conversation_id}/typing"),
        ("GET", "/api/comms/presence"),
        ("POST", "/api/comms/presence"),
        *(
            (
                method,
                "/api/comms/conversations/{conversation_id}/threads/{root_message_id}" + suffix,
            )
            for method, suffix in (
                ("GET", ""),
                ("POST", ""),
                ("PATCH", ""),
                ("GET", "/replies"),
                ("POST", "/replies"),
                ("PUT", "/follow"),
            )
        ),
        ("GET", "/api/comms/threads"),
        ("POST", "/api/comms/conversations/{conversation_id}/messages/{message_id}/reactions"),
        ("DELETE", "/api/comms/conversations/{conversation_id}/messages/{message_id}/reactions"),
        ("PUT", "/api/comms/conversations/{conversation_id}/messages/{message_id}/pin"),
        ("GET", "/api/comms/conversations/{conversation_id}/pins"),
        ("POST", "/api/comms/conversations/{conversation_id}/files"),
        ("PUT", "/api/comms/conversations/{conversation_id}/files/{file_id}/content"),
        ("GET", "/api/comms/conversations/{conversation_id}/files/{file_id}/content"),
        ("GET", "/api/comms/conversations/{conversation_id}/record-references/{reference_id}"),
        ("GET", "/api/comms/record-references"),
        ("GET", "/api/comms/conversations"),
        ("POST", "/api/comms/conversations"),
        ("GET", "/api/comms/conversations/{conversation_id}"),
        ("PATCH", "/api/comms/conversations/{conversation_id}"),
        ("POST", "/api/comms/conversations/{conversation_id}/archive"),
        ("POST", "/api/comms/conversations/{conversation_id}/restore"),
        ("GET", "/api/comms/categories"),
        ("POST", "/api/comms/categories"),
        ("GET", "/api/comms/categories/{category_id}"),
        ("PUT", "/api/comms/categories/{category_id}"),
        ("POST", "/api/comms/directs"),
        ("POST", "/api/comms/groups"),
        ("GET", "/api/comms/conversations/{conversation_id}/members"),
        ("PUT", "/api/comms/conversations/{conversation_id}/members/{user_id}"),
        ("DELETE", "/api/comms/conversations/{conversation_id}/members/{user_id}"),
        ("POST", "/api/comms/conversations/{conversation_id}/duplicates"),
        ("GET", "/api/comms/direct-blocks"),
        ("POST", "/api/comms/direct-blocks"),
        ("DELETE", "/api/comms/direct-blocks/{user_id}"),
        ("GET", "/api/comms/bootstrap"),
        ("GET", "/api/comms/conversations/{conversation_id}/messages"),
        ("POST", "/api/comms/conversations/{conversation_id}/messages"),
        ("GET", "/api/comms/conversations/{conversation_id}/messages/{message_id}"),
        ("GET", "/api/comms/conversations/{conversation_id}/messages/by-sequence/{seq}"),
        ("PATCH", "/api/comms/conversations/{conversation_id}/messages/{message_id}"),
        ("DELETE", "/api/comms/conversations/{conversation_id}/messages/{message_id}"),
        ("PUT", "/api/comms/conversations/{conversation_id}/read"),
        ("GET", "/api/comms/preferences"),
        ("PUT", "/api/comms/preferences"),
        ("GET", "/api/comms/conversations/{conversation_id}/preferences"),
        ("PATCH", "/api/comms/conversations/{conversation_id}/preferences"),
        ("GET", "/api/comms/categories/{category_id}/preferences"),
        ("PUT", "/api/comms/categories/{category_id}/preferences"),
        ("PUT", "/api/comms/settings/workspace/locks"),
        ("GET", "/api/comms/settings/workspace/capability-locks"),
        ("PUT", "/api/comms/settings/workspace/capability-locks"),
        ("GET", "/api/comms/conversations/{conversation_id}/capabilities"),
        ("GET", "/api/comms/conversations/{conversation_id}/capabilities/{user_id}"),
        ("GET", "/api/comms/capabilities/channel-creation"),
        # D45: the UI fixes the {subject} path parameter, so each subject is listed.
        *(
            (method, target + suffix)
            for target in (
                "/api/comms/conversations/{conversation_id}",
                "/api/comms/categories/{category_id}",
            )
            for method, suffix in (
                ("GET", "/access-grants"),
                ("GET", "/access-candidates"),
                ("PUT", "/access-grants/group/{subject_id}"),
                ("PUT", "/access-grants/user/{subject_id}"),
                ("DELETE", "/access-grants/group/{subject_id}"),
                ("DELETE", "/access-grants/user/{subject_id}"),
            )
        ),
        *(
            (method, "/api/comms/settings/" + scope + suffix)
            for scope in ("workspace", "category/{category_id}", "channel/{conversation_id}")
            for method, suffix in (
                ("GET", ""),
                ("PATCH", ""),
                ("POST", "/reset"),
                ("GET", "/capabilities"),
                ("PUT", "/capabilities"),
            )
        ),
    }
)
