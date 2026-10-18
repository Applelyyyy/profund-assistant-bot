# TA Queue

An operational dashboard and Discord platform for university coursework inspections. Students verify identity, wait in voice, choose coursework, receive a durable ticket, and move to the assigned TA. Administrators manage identity, capacity, permissions, panels, support, and recovery.

## Audience and scene

University administrators and TAs operating busy coursework sessions: roughly 70 students and 10 TAs, with bursts of 200 interactions. Student and TA interaction takes place in Discord. The website is a local administration tool.

## Product commitments

PostgreSQL is authoritative. Capacity, claims, ownership and transitions are atomic and audited. Stopping admission drains existing tickets. Discord transfers require observed success. No fabricated health, rankings, or queue entries. No credentials in browser code. Existing data must survive restart.

## Visual commitments

User chose dark dashboard by default with a light theme available. Premium, clean, minimal, responsive SaaS administration. Sidebar, accessible forms, readable tables, clear states and real operational feedback. No decorative marketing surface. English administration interface, Thai Discord defaults, and preserved custom Discord content. Prioritize queue visibility, TA room ownership, and recovery status.

## Scope and success

The full requested platform: Discord panels and interactions, PostgreSQL queue engine, worker, local admin authentication and CRUD, student CSV, support, embed editing, analytics, observability and safe recovery. Real Discord credentials are required for live acceptance. Production readiness requires verified security and reliability, not visual completeness.
