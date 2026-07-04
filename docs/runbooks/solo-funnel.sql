-- Solo teacher signup funnel — drop into /app/admin dashboard as a tile.
-- Last 14 days, broken down by role. Run as the system role (BYPASSRLS).

SELECT
  to_char(date_trunc('day', u.created_at), 'YYYY-MM-DD') AS day,
  count(*) FILTER (WHERE u.role = 'teacher')              AS solo_teachers,
  count(*) FILTER (WHERE u.role = 'educational_assistant') AS eas,
  count(*) FILTER (WHERE u.role = 'school_admin')         AS admins,
  count(*)                                                AS total
FROM users u
WHERE u.created_at > now() - interval '14 days'
GROUP BY 1
ORDER BY 1 DESC;

-- Single-row summary (last 7d vs prior 7d, by role)
WITH buckets AS (
  SELECT
    u.role,
    count(*) FILTER (WHERE u.created_at > now() - interval '7 days') AS last_7d,
    count(*) FILTER (WHERE u.created_at <= now() - interval '7 days'
                     AND u.created_at >  now() - interval '14 days') AS prior_7d
  FROM users u
  WHERE u.created_at > now() - interval '14 days'
  GROUP BY u.role
)
SELECT
  role,
  last_7d,
  prior_7d,
  CASE WHEN prior_7d = 0 THEN NULL
       ELSE round((last_7d::numeric - prior_7d) / prior_7d * 100, 1)
  END AS wow_pct
FROM buckets
ORDER BY last_7d DESC;

-- Wizard completion rate (last 30d, solo teacher signups only):
--   completed = user has at least 1 duty_assignment
WITH solo_signups AS (
  SELECT u.id, u.created_at
  FROM users u
  WHERE u.role = 'teacher'
    AND u.created_at > now() - interval '30 days'
),
completed AS (
  SELECT DISTINCT da.user_id
  FROM duty_assignments da
  JOIN solo_signups s ON s.id = da.user_id
)
SELECT
  (SELECT count(*) FROM solo_signups) AS solo_signups_30d,
  (SELECT count(*) FROM completed)    AS completed_wizard_30d,
  CASE WHEN (SELECT count(*) FROM solo_signups) = 0 THEN NULL
       ELSE round(
         (SELECT count(*) FROM completed)::numeric
         / (SELECT count(*) FROM solo_signups) * 100, 1)
  END                                AS completion_pct;