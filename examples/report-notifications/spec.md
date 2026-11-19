---
genesis_spec: 1
revision: 1
sources:
  request:
    kind: user
    ref: "example:report-notifications/request"
    quote: "报告提交失败时，不要发送成功通知。"
requirements:
  REQ-submit-failure:
    source: request
    state: explicit
open_questions: []
---

# 报告提交通知

## Purpose

让报告提交的通知准确反映实际提交结果，避免用户在提交失败时收到误导性的成功通知，并为后续开发提供可重复验证的业务验收依据。

## ADDED Requirements

### Requirement: REQ-submit-failure 提交失败时不发送成功通知

系统 MUST 在报告提交失败时不发送成功通知。

#### Scenario: 提交失败

- **WHEN** 报告提交返回失败
- **THEN** 本次提交发送的成功通知数量为零
