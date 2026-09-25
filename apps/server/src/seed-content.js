/**
 * Course catalogue, notice board and message traffic for the demo.
 *
 * Kept out of seed.js because it is content rather than structure: long prose
 * that wants editing on its own, and a place to look when someone asks "what
 * does a real training library look like in here".
 *
 * A word on the videos. The footage is Blender Foundation open movies from
 * Google's public test bucket - the standard HTML5 sample files, openly
 * licensed. They are obviously not real security training; they are there so
 * the player, the progress tracking and the completion rules can be exercised
 * against actual video rather than a timer. Replace video_url with your own
 * footage and nothing else has to change.
 */

/**
 * Placeholder footage, served by the app itself.
 *
 * Two short openly licensed clips - Big Buck Bunny (CC BY, Blender Foundation)
 * and MDN's flower clip (CC0) - live in apps/web/public/training. They are
 * obviously not real security training; they are there so the player, the
 * progress tracking and the completion rules can be exercised against actual
 * video rather than a timer.
 *
 * Self-hosted rather than linked, because the first version of this pointed at
 * Google's public sample bucket and that started returning 403, which left
 * every course in the catalogue showing "video unavailable". A demo should not
 * depend on somebody else's bucket staying open.
 *
 * Swap in your own footage by replacing the files and setting duration_seconds
 * to the real running time - that is what the completion rule measures.
 */
export const CLIPS = [
  // Durations read from the files themselves, not guessed: the completion
  // rule measures against duration_seconds, so a course claiming to be longer
  // than its footage can never be finished.
  { url: '/training/bbb-10s.mp4', poster: null, seconds: 10 },
  { url: '/training/flower.mp4', poster: null, seconds: 5 },
];

/**
 * The course catalogue.
 *
 * `required` courses block nothing on their own but appear on the officer's
 * home screen and in the supervisor's completion board, which is where the
 * chasing happens. `audienceRole` limits a course to one tier - firearms
 * requalification has no business on a Class D officer's list.
 */
export const TRAININGS = [
  {
    title: 'Florida Class D: Powers, Limits and Detention',
    description:
      'What a licensed security officer may and may not do in Florida. Covers the difference between a citizen detention and an arrest, when force becomes unlawful, trespass warnings, and the point at which an incident stops being ours and becomes law enforcement’s. Required annually for every officer.',
    required: true,
    dueInDays: 21,
    clip: 5,
  },
  {
    title: 'Use of Force and the Reasonable Officer Standard',
    description:
      'The force continuum applied to guarding work, where the honest answer is almost always presence and words. Includes what "objectively reasonable" means when it is read back to you in a deposition, and the reporting that has to follow any hands-on contact.',
    required: true,
    dueInDays: 21,
    clip: 6,
  },
  {
    title: 'Verbal De-escalation on Post',
    description:
      'Talking somebody down at a gate, a lobby desk or a loading dock. Positioning, tone, giving a person a way to leave with their dignity, and recognising the moment to stop talking and call it in.',
    required: true,
    dueInDays: 14,
    clip: 2,
  },
  {
    title: 'Report Writing That Holds Up',
    description:
      'Writing an incident report a client, an insurer or a court can rely on: what you saw against what you concluded, times and names, and why "appeared intoxicated" costs a case that "unsteady on his feet, smelled of alcohol" would have won.',
    required: true,
    dueInDays: 30,
    clip: 7,
  },
  {
    title: 'Fire Alarm Response and Evacuation',
    description:
      'First actions on an alarm, how to read a panel, staging the fire department on arrival, sweeping a floor safely, and the accountability point. Site-specific annexes are in your post orders.',
    required: true,
    dueInDays: 45,
    clip: 0,
  },
  {
    title: 'Active Threat: Avoid, Deny, Defend',
    description:
      'What an unarmed officer is actually able to do in the first ninety seconds, how to give dispatch information police can use, and why the lobby console is not a barricade.',
    required: true,
    dueInDays: 45,
    clip: 4,
  },
  {
    title: 'Bloodborne Pathogens and Basic First Aid',
    description:
      'OSHA-aligned refresher: exposure control, gloves and barrier devices, what to do with a needle stick, and the bleeding control steps worth knowing before paramedics arrive.',
    required: true,
    dueInDays: 60,
    clip: 1,
  },
  {
    title: 'Radio Protocol and Dispatch Discipline',
    description:
      'Clear traffic under pressure: plain language over ten-codes, priority traffic, how to hold a channel during an incident, and confirming a dispatch actually heard you.',
    required: false,
    clip: 3,
  },
  {
    title: 'Access Control and Tailgating',
    description:
      'Badge verification, visitor handling, contractor escorts, and the polite scripts that stop somebody walking in behind an employee without turning it into a confrontation.',
    required: false,
    clip: 2,
  },
  {
    title: 'Recognising Workplace Violence Indicators',
    description:
      'Behavioural warning signs on a client site, how to escalate a concern about an employee without accusing anyone, and the documentation that protects both the client and the person reported.',
    required: false,
    clip: 4,
  },
  {
    title: 'Customer Service at a Client Site',
    description:
      'The part of the job that gets a contract renewed. Greeting, wayfinding, handling an angry resident or tenant, and remembering whose building you are standing in.',
    required: false,
    clip: 3,
  },
  {
    title: 'Class G Firearms: Requalification and Retention',
    description:
      'For armed posts only. Requalification standards, safe handling on and off post, weapon retention at close quarters, and the reporting required after any draw - whether or not a round is fired.',
    required: true,
    dueInDays: 30,
    audienceRole: null,
    armedOnly: true,
    clip: 0,
  },
  {
    title: 'Supervising a Shift: Coaching and Documentation',
    description:
      'For field supervisors. Running a post visit that is worth the drive, correcting an officer without losing them, what has to be written down at the time, and when a performance conversation becomes an HR matter.',
    required: false,
    audienceRole: 'supervisor',
    clip: 5,
  },
];

/**
 * The notice board.
 *
 * Officers see these on their Updates tab; anything marked `requiresAck` is
 * chased until every officer has confirmed it. `daysAgo` places them along a
 * timeline so the feed is not all one date, and `expiresInDays` retires the
 * ones that were only ever relevant for a week.
 */
export const BROADCASTS = [
  {
    title: 'Hurricane season: standby procedures now in force',
    priority: 'urgent',
    requiresAck: true,
    daysAgo: 1,
    body: `Storm season standby is in force for all Florida posts from today.

Before every shift, check the storm annex in your post orders for the site you are covering. If a tropical storm or hurricane watch is issued for your county, call dispatch at the start of your shift to confirm coverage and relief arrangements before you take the post.

During a warning, no post is to be left unattended without relief physically on site. If your relief has not arrived and you cannot reach your supervisor, call the dispatch line and stay on post until you are told otherwise. You will be paid for the time.

Keep a charged phone, a torch and water with you. If site conditions become unsafe, your own safety comes first: withdraw to a safe location and report in.`,
  },
  {
    title: 'New uniform supplier from 1 October',
    priority: 'normal',
    requiresAck: false,
    daysAgo: 4,
    body: `We have moved to a new uniform supplier. Existing uniforms remain in service - nobody needs to buy anything.

Replacement shirts, trousers and outerwear are ordered through your supervisor. Sizes have changed slightly between suppliers, so confirm your size at your next post visit rather than assuming it carries over.

Damaged uniform items are replaced at company cost when the damage happened on post. Wear and tear over time is also covered. Loss is not.`,
  },
  {
    title: 'Riverfront: loading dock access changes',
    priority: 'important',
    requiresAck: true,
    daysAgo: 6,
    site: 'riverfront',
    body: `The tenant on level 3 has taken over the east loading bay. From Monday, deliveries for that tenant use the east bay and are logged against their account, not the building's.

Drivers will not know this. Expect to redirect for the first fortnight. The bay door code has changed; it is in your post orders, and it is not to be given out over the phone to anyone, including someone claiming to be building management.

Log every contractor vehicle with plate and company as usual.`,
  },
  {
    title: 'Payroll: direct deposit cut-off moves to Tuesday',
    priority: 'important',
    requiresAck: false,
    daysAgo: 9,
    body: `The payroll cut-off moves from Wednesday to Tuesday at 17:00, starting with the next period.

Practically this means your timesheet needs to be right by Monday night. Check your hours on the Schedule tab over the weekend. If something is wrong - a missed clock-out, a shift you covered that is not showing - tell your supervisor before Tuesday rather than after payday, when it becomes a correction on the following run.`,
  },
  {
    title: 'Palmetto Ridge: gate arm repaired',
    priority: 'normal',
    requiresAck: false,
    daysAgo: 11,
    site: 'palmetto',
    expiresInDays: 3,
    body: `The north gate arm was repaired Thursday and is back in normal service. Manual operation is no longer required.

Thanks to the officers who worked the gate by hand for nine days in August heat. It was noticed.`,
  },
  {
    title: 'Reminder: body camera footage is evidence',
    priority: 'important',
    requiresAck: true,
    daysAgo: 14,
    body: `Where a post is equipped with body cameras, footage is evidence from the moment it is recorded.

Do not delete, edit, share or post any footage. Do not show it to a client contact, a tenant or a member of the public, however reasonable the request seems - refer them to your supervisor. Requests from law enforcement go through the office, not through you on post.

Footage is retained for 30 days and longer where an incident report references it.`,
  },
  {
    title: 'Open shifts are now claimable in the app',
    priority: 'normal',
    requiresAck: false,
    daysAgo: 17,
    body: `Uncovered shifts now show on the Schedule tab under "Open". If you are eligible you can claim one and a supervisor confirms it.

Eligibility is checked automatically: you will not be offered an armed post without a current Class G on file, and you will not be offered something that clashes with a shift you already hold or with approved time off.

You can also offer a shift you hold to another officer, or ask to be taken off one. Either way the post stays covered until a supervisor decides.`,
  },
  {
    title: 'Heat illness: know the difference',
    priority: 'urgent',
    requiresAck: true,
    daysAgo: 22,
    body: `Exterior posts in August and September are the highest risk shifts we run.

Heat exhaustion is heavy sweating, cold clammy skin, nausea, dizziness. Move to shade or air conditioning, loosen clothing, sip water, and tell your supervisor.

Heat stroke is different and is a medical emergency: skin hot and often dry, confusion, slurred speech, no sweating, temperature climbing. Call 911 first, then dispatch. Cool the person any way you can while you wait.

Nobody is expected to stand an exterior post without water and shade access. If a site does not provide it, report it - that is a site problem, not yours to endure.`,
  },
  {
    title: 'Client portal is live for Riverfront and Palmetto',
    priority: 'normal',
    requiresAck: false,
    daysAgo: 26,
    body: `Site contacts at Riverfront Holdings and Palmetto Ridge HOA can now sign in and see coverage, patrol records and incident reports for their own property.

What this means on post: your clock-in and clock-out times, the checkpoints you scan and the reports you file are visible to the client, by name, the moment they are recorded. That is a good thing - it is the proof of service that keeps the contract - but write and scan accordingly.

Clients cannot see pay rates, flags, or anything about another client's property.`,
  },
  {
    title: 'Class D licence renewals due this quarter',
    priority: 'important',
    requiresAck: false,
    daysAgo: 31,
    body: `Several licences expire in the next 90 days. The Licensing board in the office tracks it, and your supervisor will speak to you individually, but the responsibility for renewing is yours.

Start the renewal at least 45 days out. An expired licence means you come off the roster the same day - we have no discretion about that, and neither do you.

If cost is the obstacle, talk to the office before your licence lapses rather than after.`,
  },
  {
    title: 'Gulfport yard: new trailer seal procedure',
    priority: 'important',
    requiresAck: true,
    daysAgo: 35,
    site: 'gulfport',
    body: `Effective immediately, every trailer arriving at the yard has its seal number photographed and logged against the bill of lading before the driver leaves the gate.

A broken, missing or mismatched seal is an incident report every time, without exception, even when the driver has a plausible explanation. Do not allow the trailer into the yard until a supervisor has been reached.

This follows a cargo loss at another operator's facility in Tampa last month.`,
  },
  {
    title: 'Welcome to USA Security Connect',
    priority: 'normal',
    requiresAck: false,
    daysAgo: 44,
    body: `This app replaces the paper sign-in sheets and the radio-and-hope method of knowing who is on post.

Clock in and out from your phone at the post. It checks where you are, so clock in when you actually arrive rather than in the car park. Status check-ins prompt you on a cadence set per post; answering takes one tap and missing one raises a flag with your supervisor, which is the point - if you stop answering, somebody comes looking.

Incident reports, tours, your schedule and your hours are all in here. If something in the app is wrong, tell your supervisor. It is easier to fix than the paperwork it replaced.`,
  },
];

/**
 * Message traffic between staff.
 *
 * Short, ordinary shift conversation - the kind that makes a messaging screen
 * look like a tool rather than an empty box.
 */
export const THREADS = [
  {
    subject: 'Relief for Friday night',
    participants: ['supervisor', 'marcus'],
    messages: [
      ['marcus', -3, 'Renata, any chance of relief around 22:00 Friday? Dental thing Saturday morning I cannot move.', 9],
      ['supervisor', -3, 'Let me see what Alicia is doing. If she can take the back half I will move it and you finish at 22:00.', 11],
      ['supervisor', -2, 'Sorted - Alicia picks it up at 22:00. Logged it so payroll sees the split.', 8],
      ['marcus', -2, 'Appreciated, thank you.', 8],
    ],
  },
  {
    subject: 'Riverfront camera 6 offline',
    participants: ['supervisor', 'marcus', 'admin'],
    messages: [
      ['marcus', -2, 'Camera 6 on the lobby bank has been down since about 18:00. Nothing on the monitor, no error, just black.', 18],
      ['supervisor', -2, 'Noted. Is it the camera or the feed? Can you see the others on the same run?', 19],
      ['marcus', -2, '5 and 7 are fine, so it looks like the camera itself.', 19],
      ['supervisor', -1, 'Reported to building management. They have a contractor booked Tuesday. Log a note on each shift until it is back.', 9],
      ['admin', -1, 'Raise it with Dana too when you speak to her - it is their equipment, not ours, and I want it in writing that we flagged it.', 10],
    ],
  },
  {
    subject: 'Class G renewal - range dates',
    participants: ['supervisor', 'dwayne'],
    messages: [
      ['dwayne', -5, 'My G expires in November. Are we doing a group range date again or am I booking my own?', 14],
      ['supervisor', -5, 'Group date, likely the second week of October. I will confirm once we have numbers. Do not let it run close.', 15],
      ['dwayne', -4, 'Understood. Put me down for it.', 8],
    ],
  },
  {
    subject: 'Palmetto: resident complaint',
    participants: ['supervisor', 'janelle'],
    messages: [
      ['janelle', -1, 'Resident at 8455 complained I was "rude" at the gate last night. For the record: he had no transponder, was not on the guest list, and became abusive when I asked him to pull aside. I stayed on script and logged it.', 21],
      ['supervisor', -1, 'I have read your log and listened to the gate recording. You were fine. I will speak to the HOA contact - this is the third time with the same resident.', 22],
      ['janelle', -1, 'Thank you. I did not want it coming back later.', 22],
    ],
  },
];
