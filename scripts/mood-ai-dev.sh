#!/usr/bin/env bash
# Mood AI developer inbox (v3_23) -- used by the developer (Claude Code) on the Owner's machine.
#
#   scripts/mood-ai-dev.sh list                         requests the Owner approved (SUBMITTED / IN_PROGRESS / NEEDS_INFO / READY_FOR_REVIEW)
#   scripts/mood-ai-dev.sh show DR-0001                 one request: full prompt + history
#   scripts/mood-ai-dev.sh report DR-0001 STATUS "note" [branch] [commit]
#        STATUS = IN_PROGRESS | NEEDS_INFO | READY_FOR_REVIEW | LIVE | DONE | REJECTED   (each report notifies the Owner in the app)
#   scripts/mood-ai-dev.sh phase "Phase C" "summary"    phase report to the Owner's notification bell
#
# Reads the database password from ~/.mow-db.env (LIVE_DB_URL=<password>); never prints it. LIVE only after the Owner said yes.
set -euo pipefail
PSQL="/c/Program Files/PostgreSQL/17/bin/psql.exe"
eval "$(sed '1s/^\xEF\xBB\xBF//' ~/.mow-db.env | grep '^LIVE_DB_URL=')"
export PGPASSWORD="$LIVE_DB_URL"
db() { "$PSQL" -h aws-0-ap-south-1.pooler.supabase.com -p 5432 -U postgres.bykmyttaesuyjwvtnxks -d postgres -v ON_ERROR_STOP=1 "$@"; }

case "${1:-list}" in
  list)
    db -c "select ref, status, risk, title, to_char(updated_at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') as updated
           from mai_dev_requests where status in ('SUBMITTED', 'IN_PROGRESS', 'NEEDS_INFO', 'READY_FOR_REVIEW') order by submitted_at" ;;
  show)
    db -tA -v ref="$2" <<< "select format(E'%s  %s  (status %s, risk %s)\nGoal: %s\nDone when: %s\nQuestions: %s\nBranch: %s\n\n%s',
             ref, title, status, risk, goal, acceptance, questions, coalesce(branch, '-'), prompt) from mai_dev_requests where ref = :'ref'"
    db -tA -v ref="$2" <<< "select to_char(e.at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || '  ' || coalesce(u.full_name, 'Developer') || '  ' || coalesce(e.status, '') || '  ' || e.note
           from mai_dev_events e join mai_dev_requests r on r.id = e.request_id left join user_profiles u on u.id = e.actor where r.ref = :'ref' order by e.id" ;;
  report)
    db -q -v ref="$2" -v st="$3" -v note="$4" -v br="${5:-}" -v cm="${6:-}" \
      <<< "select public.mai_dev_report(:'ref', :'st', :'note', nullif(:'br', ''), nullif(:'cm', ''))" && echo "reported $2 $3 (Owner notified)" ;;
  phase)
    db -q -v ph="$2" -v sm="$3" <<< "select public.mai_phase_report(:'ph', :'sm')" && echo "phase report sent" ;;
  *) echo "usage: $0 list | show REF | report REF STATUS note [branch] [commit] | phase NAME summary"; exit 1 ;;
esac
