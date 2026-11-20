---
genesis_spec: 1
revision: 1
sources:
  failure:
    kind: user
    ref: "本次会话，试用需求第 1 条"
    quote: "报告提交失败时，不要发送成功通知。"
  success:
    kind: user
    ref: "本次会话，试用需求第 2 条"
    quote: "报告提交成功时，仍然发送一条成功通知。"
requirements:
  REQ-submit-failure:
    source: failure
    state: explicit
  REQ-submit-success:
    source: success
    state: explicit
open_questions: []
---

# 报告提交通知

## Purpose

团队通过成功通知得知报告已提交。提交失败时，用户不应收到让人以为报告已提交的成功通知。提交成功时，团队仍然收到一条成功通知。

## ADDED Requirements

### Requirement: REQ-submit-failure 提交失败时不发送成功通知

系统 MUST 在报告提交失败时不发送成功通知。

#### Scenario: 报告提交失败

- **WHEN** 报告提交失败
- **THEN** 本次提交发送的成功通知数量为零

### Requirement: REQ-submit-success 提交成功时发送一条成功通知

系统 MUST 在报告提交成功时发送一条成功通知。

#### Scenario: 报告提交成功

- **WHEN** 报告提交成功
- **THEN** 本次提交发送的成功通知数量为一
