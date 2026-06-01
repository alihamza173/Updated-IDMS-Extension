# Automated Report Generator (Scaffold)

This repository contains a first-milestone Chrome Extension scaffold for:

- Configuring webhook URL and custom report buttons
- Rendering a floating panel in target pages
- Capturing selector mappings in discovery mode
- Running a state-machine shell for automation
- Sending webhook payloads through a background service worker

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder

## Current Scaffold Scope

Implemented:

- MV3 manifest and service worker
- Options page with button CRUD
- Popup with quick actions
- Floating panel in page
- Discovery mode selector capture
- Automation state machine with real selector helpers for core steps
- Result evaluation branch with multi-result picker modal
- Download-event CSV capture handshake (content script <-> background)
- Webhook message path and retry in background script

Not implemented yet:

- Reading actual CSV file bytes from disk/download path
- fetch/XHR capture strategy option
- Failed-job persistence queue

## Storage Model

```json
{
  "webhookUrl": "https://example.com/webhook",
  "buttons": [
    {
      "id": "uuid",
      "label": "Sales Report",
      "searchText": "monthly sales"
    }
  ],
  "selectorConfig": {
    "search_input": {
      "capturedAt": "2026-04-20T00:00:00.000Z",
      "selectors": [
        "input[name=\"search\"]",
        "#search-box"
      ]
    }
  }
}
```

## Next Build Target

Implement CSV capture and resilient delivery:

- fetch/XHR capture strategy option
- optional multipart upload with CSV file bytes
- failed-job persistence queue and replay

## Required Selector Keys For Current Flow

- `search_input`
- `results_container`
- `result_play_button`
- `generate_button`
- `format_dropdown`
- `format_csv_option`

Optional keys:

- `generation_complete_indicator`
- `search_submit`
- `result_row`
