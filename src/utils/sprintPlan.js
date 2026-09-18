// Work out what the next sprint should be called and when it should run, from the sprints
// a board already has. Teams name sprints in a series and run them on a fixed cadence, so
// almost everything the create dialog needs is already sitting in that history — the point
// is to read it rather than ask for it again.

const DAY = 24 * 60 * 60 * 1000;

// What to fall back on for a board with nothing to learn from
export const DEFAULT_CADENCE_DAYS = 14;
const DEFAULT_START_WEEKDAY = 1; // Monday
const DEFAULT_START_HOUR = 9;

const time = value => {
  const date = value ? new Date(value) : null;
  return date && !isNaN(date.getTime()) ? date : null;
};

/**
 * The sprint a new one would follow: the one that runs latest. Dates decide it where they
 * exist, and the id where they do not — Jira hands them out in order, so the highest id is
 * the most recently created.
 */
export function latestSprint(sprints) {
  const dated = (sprints || []).filter(s => time(s.endDate) || time(s.startDate));
  if (dated.length) {
    return dated.reduce((latest, sprint) => {
      const end = time(sprint.endDate) || time(sprint.startDate);
      const best = time(latest.endDate) || time(latest.startDate);
      return end > best ? sprint : latest;
    });
  }
  return (sprints || []).reduce((latest, sprint) => (
    !latest || Number(sprint.id) > Number(latest.id) ? sprint : latest
  ), null);
}

/**
 * How long this board's sprints actually run, in whole days. The median rather than the
 * mean, because one sprint that was left open for three months should not stretch every
 * sprint planned after it. Spans that cannot be a cadence are ignored outright.
 */
export function inferCadenceDays(sprints) {
  const spans = (sprints || [])
    .map(sprint => {
      const start = time(sprint.startDate);
      const end = time(sprint.endDate);
      return start && end ? (end - start) / DAY : null;
    })
    .filter(days => days != null && days >= 1 && days <= 90)
    .sort((a, b) => a - b);
  if (spans.length === 0) return DEFAULT_CADENCE_DAYS;
  return Math.max(1, Math.round(spans[Math.floor(spans.length / 2)]));
}

/**
 * The next name in the series. The trailing number is what counts up — "Sprint 24" becomes
 * "Sprint 25", "PI 2025.3 S2" becomes "PI 2025.3 S3" — and zero padding is kept, since a
 * board naming sprints "Sprint 07" means the width. A name already in use is skipped over.
 */
export function nextSprintName(sprints) {
  const names = (sprints || []).map(s => s.name).filter(Boolean);
  if (names.length === 0) return 'Sprint 1';
  const previous = latestSprint(sprints);
  const base = (previous && previous.name) || names[names.length - 1];

  // The last run of digits in the name, with whatever trails it
  const match = /^(.*?)(\d+)(\D*)$/.exec(base);
  if (!match) return `${base} 2`;

  const [, prefix, digits, suffix] = match;
  const width = digits.length;
  const taken = new Set(names.map(name => name.toLowerCase()));
  let counter = Number(digits);
  let candidate;
  do {
    counter += 1;
    candidate = `${prefix}${String(counter).padStart(width, '0')}${suffix}`;
  } while (taken.has(candidate.toLowerCase()) && counter < Number(digits) + 1000);
  return candidate;
}

// The next time this weekday and hour come round. Today counts, but only while that hour
// is still ahead — a sprint planned at 4pm does not start at 9am this morning.
function nextWeekdayAt(now, weekday, hours, minutes) {
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  const ahead = (weekday - next.getDay() + 7) % 7;
  if (ahead > 0) next.setDate(next.getDate() + ahead);
  else if (next <= now) next.setDate(next.getDate() + 7);
  return next;
}

/**
 * Everything the create dialog opens with: what to call the sprint, when it runs, and what
 * that was read from — so the caption can say why, and the user can disagree with it.
 *
 * A new sprint picks up the day the last one ends, which is what keeps a cadence unbroken.
 * When the last sprint has already finished, there is a gap rather than a chain, so the
 * plan starts from the next time the team's usual start day comes round.
 */
export function planNextSprint(sprints, now = new Date()) {
  const cadenceDays = inferCadenceDays(sprints);
  const previous = latestSprint(sprints);
  const previousEnd = previous ? time(previous.endDate) : null;
  const previousStart = previous ? time(previous.startDate) : null;

  let start;
  let follows = null;
  if (previousEnd && previousEnd > now) {
    start = new Date(previousEnd);
    follows = previous.name;
  } else if (previousStart) {
    // Keep the day of the week and the hour the team already starts sprints on
    start = nextWeekdayAt(now, previousStart.getDay(), previousStart.getHours(), previousStart.getMinutes());
  } else {
    start = nextWeekdayAt(now, DEFAULT_START_WEEKDAY, DEFAULT_START_HOUR, 0);
  }

  return {
    name: nextSprintName(sprints),
    start,
    end: new Date(start.getTime() + cadenceDays * DAY),
    cadenceDays,
    follows,
    // True when the cadence is a guess rather than something the board demonstrated
    cadenceAssumed: inferCadenceDays(sprints) === DEFAULT_CADENCE_DAYS &&
      !(sprints || []).some(s => time(s.startDate) && time(s.endDate))
  };
}
