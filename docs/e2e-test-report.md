# EigenFlux Claude Code Plugin — End-to-End Test Report

**Run at:** 2026-04-16T10:34:09.917Z
**Result:** 5/5 assertions passed
**Plugin dir:** `/Users/phronex/git/phro-2026/agent_network/eigenflux-claude`

## Assertions

- PASS — scenario 1 (skill discovery) exited 0
- PASS — scenario 2 (mcp tools discovery) exited 0
- PASS — scenario 1 agent reply lists at least one ef-* skill; got: "ef-broadcast\nef-communication\nef-profile"
- PASS — scenario 2 agent reply lists at least one eigenflux MCP tool; got: "mcp__plugin_eigenflux_eigenflux__eigenflux_block_agent\nmcp__plugin_eigenflux_eigenflux__eigenflux_close_conversation\nmcp__plugin_eigenflux_eigenflux__eigenflux_delete_broadcast\nmcp__plugin_eigenflux_eigenflux__eigenflux_feedback\nmcp__plugin_eigenflux_eigenflux__eigenflux_get_conversation_histor
- PASS — eigenflux MCP server connected (either visible in stream or agent found eigenflux tools)

## Scenarios

### skill-discovery

- **prompt:** `List all skills whose name starts with "ef-" (EigenFlux skills: ef-broadcast, ef-communication, ef-profile). Reply with just the names, one per line. If none are available, reply only the single word NONE.`
- **exit_code:** 0
- **events:** 6
- **stderr (tail):**

```

```

- **final result event:**

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "api_error_status": null,
  "duration_ms": 2794,
  "duration_api_ms": 2773,
  "num_turns": 1,
  "result": "ef-broadcast\nef-communication\nef-profile",
  "stop_reason": "end_turn",
  "session_id": "27382718-181f-4158-ae26-618e1b938765",
  "total_cost_usd": 0.2209925,
  "usage": {
    "input_tokens": 6,
    "cache_creation_input_tokens": 35262,
    "cache_read_input_tokens": 0,
    "output_tokens": 23,
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 35262,
      "ephemeral_5m_input_tokens": 0
    },
    "inference_geo": "",
    "iterations": [
      {
        "input_tokens": 6,
        "output_tokens": 23,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 35262,
        "cache_creation": {
          "ephemeral_5m_input_tokens": 0,
          "ephemeral_1h_input_tokens": 35262
        },
        "type": "message"
      }
    ],
    "speed": "standard"
  },
  "modelUsage": {
    "claude-opus-4-6[1m]": {
      "inputTokens": 6,
      "outputTokens": 23,
      "cacheReadInputTokens": 0,
      "cacheCreationInputTokens": 35262,
      "webSearchRequests": 0,
      "costUSD": 0.2209925,
      "contextWindow": 1000000,
      "maxOutputTokens": 64000
    }
  },
  "permission_denials": [],
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "uuid": "1844095f-1fbf-4299-9dab-5b69d5401f14"
}
```

### mcp-tools-discovery

- **prompt:** `List every MCP tool you have available whose name contains the substring "eigenflux" (tools typically look like mcp__plugin_eigenflux_eigenflux__<toolname> or eigenflux_<toolname>). Reply one full tool name per line, no commentary. If none exist, reply only NONE.`
- **exit_code:** 0
- **events:** 6
- **stderr (tail):**

```

```

- **final result event:**

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "api_error_status": null,
  "duration_ms": 9709,
  "duration_api_ms": 9684,
  "num_turns": 1,
  "result": "mcp__plugin_eigenflux_eigenflux__eigenflux_block_agent\nmcp__plugin_eigenflux_eigenflux__eigenflux_close_conversation\nmcp__plugin_eigenflux_eigenflux__eigenflux_delete_broadcast\nmcp__plugin_eigenflux_eigenflux__eigenflux_feedback\nmcp__plugin_eigenflux_eigenflux__eigenflux_get_conversation_history\nmcp__plugin_eigenflux_eigenflux__eigenflux_get_my_broadcasts\nmcp__plugin_eigenflux_eigenflux__eigenflux_get_profile\nmcp__plugin_eigenflux_eigenflux__eigenflux_get_settings\nmcp__plugin_eigenflux_eigenflux__eigenflux_handle_friend_request\nmcp__plugin_eigenflux_eigenflux__eigenflux_list_conversations\nmcp__plugin_eigenflux_eigenflux__eigenflux_list_relations\nmcp__plugin_eigenflux_eigenflux__eigenflux_login\nmcp__plugin_eigenflux_eigenflux__eigenflux_poll_feed\nmcp__plugin_eigenflux_eigenflux__eigenflux_poll_pm\nmcp__plugin_eigenflux_eigenflux__eigenflux_publish\nmcp__plugin_eigenflux_eigenflux__eigenflux_save_token\nmcp__plugin_eigenflux_eigenflux__eigenflux_send_friend_request\nmcp__plugin_eigenflux_eigenflux__eigenflux_send_pm\nmcp__plugin_eigenflux_eigenflux__eigenflux_unfriend\nmcp__plugin_eigenflux_eigenflux__eigenflux_update_profile\nmcp__plugin_eigenflux_eigenflux__eigenflux_update_remark\nmcp__plugin_eigenflux_eigenflux__eigenflux_update_settings\nmcp__plugin_eigenflux_eigenflux__eigenflux_verify_login",
  "stop_reason": "end_turn",
  "session_id": "b03e221d-46ac-4770-872b-6d782ca9a4e6",
  "total_cost_usd": 0.238805,
  "usage": {
    "input_tokens": 6,
    "cache_creation_input_tokens": 35288,
    "cache_read_input_tokens": 0,
    "output_tokens": 729,
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 35288,
      "ephemeral_5m_input_tokens": 0
    },
    "inference_geo": "",
    "iterations": [
      {
        "input_tokens": 6,
        "output_tokens": 729,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 35288,
        "cache_creation": {
          "ephemeral_5m_input_tokens": 0,
          "ephemeral_1h_input_tokens": 35288
        },
        "type": "message"
      }
    ],
    "speed": "standard"
  },
  "modelUsage": {
    "claude-opus-4-6[1m]": {
      "inputTokens": 6,
      "outputTokens": 729,
      "cacheReadInputTokens": 0,
      "cacheCreationInputTokens": 35288,
      "webSearchRequests": 0,
      "costUSD": 0.238805,
      "contextWindow": 1000000,
      "maxOutputTokens": 64000
    }
  },
  "permission_denials": [],
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "uuid": "2d32a172-8bd4-4331-8dcd-df621345c3a3"
}
```
