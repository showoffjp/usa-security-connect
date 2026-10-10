/**
 * The larger half of the demo company.
 *
 * seed.js builds the original four sites and eight people that the test
 * suites are written against, and nothing here changes any of that. This adds
 * a regional operation around it - six more client sites across Florida,
 * thirty-five more staff on W-2 and 1099 terms, a month of rosters, and the
 * GPS history those rosters would have produced.
 *
 * Everything is placed relative to the moment the seed runs, and classified
 * by time rather than by day: a shift that has ended was worked, one that is
 * running has somebody on post right now, one that has not started is on the
 * schedule. So whatever hour it is when the seed runs, the live board has
 * officers on post, one walking off it, one on a break, one with a GPS signal
 * gone quiet, one running late and one who never turned up.
 *
 * Randomness is seeded, so two runs at the same time produce the same company.
 */

import { RULES, evaluateGeofence } from './shared.js';

/* ------------------------------------------------------------ utilities -- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A point `meters` away from (lat, lng) at `angle` radians (0 = east). */
function offsetPoint(lat, lng, meters, angle) {
  const dLat = (Math.sin(angle) * meters) / 111320;
  const dLng = (Math.cos(angle) * meters) / (111320 * Math.cos((lat * Math.PI) / 180));
  return [Number((lat + dLat).toFixed(6)), Number((lng + dLng).toFixed(6))];
}

const MINUTE = 60000;
const HOUR = 3600000;

/* ---------------------------------------------------------------- sites -- */

const SITES = [
  {
    key: 'harborview',
    name: 'Harborview Medical Center',
    client: 'Harborview Health System',
    address: '1611 NW 12th Ave',
    city: 'Miami',
    zip: '33136',
    // Geocoded: the hospital at this address (OpenStreetMap).
    lat: 25.79167,
    lng: -80.212602,
    contact: ['Carla Mendez', '(305) 555-0147', 'carla.mendez@harborviewhealth.org'],
    posts: [
      {
        key: 'hvEd', name: 'Emergency Department Entrance', code: 'HV-01', dx: 40, dy: -30,
        radius: 120, interval: 60, bill: 3150, armed: false,
        instructions: [
          'Staff the ED ambulance bay and walk-in doors at all times.',
          'Every visitor past triage signs in and wears a visitor band.',
          'Code Grey (combative person): call the charge nurse and radio the supervisor before intervening.',
          'Keep the ambulance lane clear - no private vehicles, no exceptions.',
        ],
      },
      {
        key: 'hvGarage', name: 'Parking Garage Patrol', code: 'HV-02', dx: -160, dy: 90,
        radius: 250, interval: 45, bill: 2900, armed: false,
        instructions: [
          'Drive levels 1-6 every hour; walk the stairwells on the half hour.',
          'Escort staff to their vehicles on request after 19:00.',
          'Log every vehicle left overnight in the patient area with plate and level.',
        ],
      },
      {
        key: 'hvLobby', name: 'Main Lobby Visitor Desk', code: 'HV-03', dx: -20, dy: 25,
        radius: 100, interval: 90, bill: 2800, armed: false,
        instructions: [
          'Issue visitor badges against photo ID. Maternity ward visitors need a band from L&D.',
          'Deliveries go to the loading dock, never through the lobby.',
        ],
      },
    ],
  },
  {
    key: 'bayfront',
    name: 'Bayfront Marina & Yacht Club',
    client: 'Bayfront Marina Partners',
    address: '300 Bayshore Dr NE',
    city: 'St. Petersburg',
    zip: '33701',
    // Geocoded: US Census address range.
    lat: 27.774964,
    lng: -82.631225,
    contact: ['Graham Whitlock', '(727) 555-0162', 'gwhitlock@bayfrontmarina.com'],
    posts: [
      {
        key: 'bmDock', name: 'Dock & Gate Patrol', code: 'BM-01', dx: 60, dy: 20,
        radius: 220, interval: 60, bill: 2700, armed: false,
        instructions: [
          'Dock gates A-D are keycard only after 20:00. Check each gate latches behind members.',
          'Walk every finger pier twice per shift; report any vessel riding low or with a bilge alarm.',
          'Fuel dock closes at 19:00 - confirm pumps are locked.',
        ],
      },
    ],
  },
  {
    key: 'capital',
    name: 'Capital Plaza Office Tower',
    client: 'Capital Plaza Realty Trust',
    address: '215 S Monroe St',
    city: 'Tallahassee',
    zip: '32301',
    // Geocoded: the building at this address (OpenStreetMap).
    lat: 30.440218,
    lng: -84.280076,
    contact: ['Denise Faulkner', '(850) 555-0118', 'dfaulkner@capitalplazart.com'],
    posts: [
      {
        key: 'cpLobby', name: 'Lobby Security Desk', code: 'CP-01', dx: 10, dy: 10,
        radius: 100, interval: 60, bill: 2750, armed: false,
        instructions: [
          'Tenants badge through the turnstiles; visitors are pre-registered by the tenant or turned away.',
          'Floors 14-16 (state agency tenant) require an escort for every visitor.',
          'Lock the Monroe St doors at 19:00 and the Jefferson St doors at 22:00.',
        ],
      },
      {
        key: 'cpGarage', name: 'Garage & Loading Dock - Armed', code: 'CP-02', dx: -70, dy: -60,
        radius: 180, interval: 30, bill: 3900, armed: true,
        instructions: [
          'Armed post. Weapon inspection logged at the start and end of every shift.',
          'Loading dock opens 05:30 for scheduled deliveries only - check the manifest.',
          'Garage levels P1-P3 walked every hour; level P3 is closed to the public overnight.',
        ],
      },
    ],
  },
  {
    key: 'research',
    name: 'Sunshine State University Research Park',
    client: 'SSU Research Foundation',
    address: '3200 SW 34th St',
    city: 'Gainesville',
    zip: '32608',
    // Geocoded: the building at this address (OpenStreetMap; Census agrees within 8 m).
    lat: 29.624554,
    lng: -82.372631,
    contact: ['Dr. Anil Rao', '(352) 555-0133', 'arao@ssuresearch.org'],
    posts: [
      {
        key: 'rpLab', name: 'Lab Building Access Control', code: 'RP-01', dx: 30, dy: 50,
        radius: 120, interval: 60, bill: 2850, armed: false,
        instructions: [
          'Badge access only. Tailgating into the BSL-2 wing is reported every time, whoever it is.',
          'Hazmat deliveries are signed for by EHS, never by security.',
          'Freezer alarm panel on the ground floor: any red light is a call to the on-call researcher.',
        ],
      },
      {
        key: 'rpPatrol', name: 'Campus Mobile Patrol', code: 'RP-02', dx: -200, dy: -150,
        radius: 450, interval: 60, bill: 3000, armed: false,
        instructions: [
          'Vehicle patrol of all five buildings and the two surface lots.',
          'Check every exterior door on the loading side of buildings B and D.',
          'Unlock the greenhouse for the 05:00 irrigation crew only against their list.',
        ],
      },
    ],
  },
  {
    key: 'seaside',
    name: 'Seaside Outlet Mall',
    client: 'Seaside Retail Holdings',
    address: '1800 N Atlantic Ave',
    city: 'Daytona Beach',
    zip: '32118',
    // Geocoded: the building at this address (OpenStreetMap).
    lat: 29.254751,
    lng: -81.021166,
    contact: ['Monica Travers', '(386) 555-0171', 'mtravers@seasideretail.com'],
    posts: [
      {
        key: 'soFloor', name: 'Mall Floor Patrol', code: 'SO-01', dx: 0, dy: 0,
        radius: 260, interval: 60, bill: 2700, armed: false,
        instructions: [
          'High-visibility patrol of both wings and the food court.',
          'Store managers call for assistance on channel 3. Do not detain - observe and report.',
          'Lost children: hold at the guest services desk and page, never announce the child’s name.',
        ],
      },
    ],
  },
  {
    key: 'pensacola',
    name: 'Pensacola Distribution Center',
    client: 'Emerald Coast Logistics',
    address: '5600 N W St',
    city: 'Pensacola',
    zip: '32505',
    // Geocoded: US Census address range.
    lat: 30.467104,
    lng: -87.253237,
    contact: ['Russell Pike', '(850) 555-0190', 'rpike@emeraldcoastlogistics.com'],
    posts: [
      {
        key: 'pdGate', name: 'Gatehouse & Truck Inspection', code: 'PD-01', dx: 80, dy: -40,
        radius: 150, interval: 60, bill: 3100, armed: false,
        instructions: [
          'Every inbound truck: driver ID, bill of lading, seal number checked against the manifest.',
          'Outbound trailers are sealed in front of you. Record the seal number before the gate opens.',
          'No passengers past the gate. No exceptions for "ride-alongs".',
        ],
      },
      {
        key: 'pdWarehouse', name: 'Warehouse Interior - Armed', code: 'PD-02', dx: -60, dy: 70,
        radius: 200, interval: 30, bill: 3850, armed: true,
        instructions: [
          'Armed post covering the high-value cage (electronics and pharma).',
          'Cage opens only for two named staff together. Log both names and the time.',
          'Walk the racking aisles every 30 minutes and scan the aisle-end tags.',
        ],
      },
    ],
  },
];

/* ----------------------------------------------------------------- staff -- */

// [code, first, last, role, site, city, area, type, rate, bill, licence, extras]
const STAFF = [
  ['1009', 'Terrence', 'Boyd', 'supervisor', 'harborview', 'Miami', '305', 'w2', 29, 47, 'D', { hire: '2020-08-17' }],
  ['1010', 'Megan', 'Hollis', 'supervisor', 'capital', 'Tallahassee', '850', 'w2', 29.5, 47, 'G', { hire: '2019-11-04' }],

  ['1011', 'Andre', 'Mitchell', 'officer', 'harborview', 'Miami', '305', 'w2', 21.5, null, 'D', { hire: '2022-05-09' }],
  ['1012', 'Sofia', 'Ramirez', 'officer', 'harborview', 'Miami', '305', 'w2', 21, null, 'D', { hire: '2023-02-13' }],
  ['1013', 'Jamal', 'Whitaker', 'officer', 'harborview', 'Hialeah', '305', 'w2', 22, null, 'D', { hire: '2021-10-25' }],
  ['1014', 'Keisha', 'Turner', 'officer', 'harborview', 'Miami', '305', 'w2', 20.5, null, 'D', { hire: '2024-06-03' }],
  ['1015', 'Daniel', 'Cho', 'officer', 'harborview', 'Miami', '305', 'w2', 21, null, 'D', { hire: '2023-09-18' }],
  ['1016', 'Tyler', 'Brooks', 'officer', 'bayfront', 'St. Petersburg', '727', 'w2', 19.5, null, 'D', { hire: '2025-03-10' }],
  ['1017', 'Hector', 'Alvarado', 'officer', 'bayfront', 'St. Petersburg', '727', '1099', 28, null, 'D',
    { hire: '2024-11-11', business: 'Alvarado Watch Services LLC', tin: '3316', insurance: 150 }],
  ['1018', 'Brianna', 'Scott', 'officer', 'capital', 'Tallahassee', '850', 'w2', 20, null, 'D', { hire: '2024-01-22' }],
  ['1019', 'Owen', 'Gallagher', 'officer', 'capital', 'Tallahassee', '850', 'w2', 20, null, 'D', { hire: '2025-07-07' }],
  ['1020', 'Raymond', 'Hayes', 'officer', 'capital', 'Tallahassee', '850', '1099', 36, null, 'G',
    { hire: '2022-02-14', business: 'Hayes Tactical Security LLC', tin: '5540', insurance: 210 }],
  ['1021', 'Emily', 'Novak', 'officer', 'research', 'Gainesville', '352', 'w2', 20.5, null, 'D', { hire: '2023-05-01' }],
  ['1022', 'Christopher', 'Lane', 'officer', 'research', 'Gainesville', '352', 'w2', 20.5, null, 'D', { hire: '2024-08-19' }],
  ['1023', 'Isaiah', 'Coleman', 'officer', 'research', 'Gainesville', '352', 'w2', 21.5, null, 'D', { hire: '2021-03-15' }],
  ['1024', 'Natalie', 'Price', 'officer', 'seaside', 'Daytona Beach', '386', 'w2', 19, null, 'D', { hire: '2025-10-06' }],
  ['1025', 'Luis', 'Castillo', 'officer', 'seaside', 'Daytona Beach', '386', '1099', 27, null, 'D',
    { hire: '2025-01-13', business: 'Castillo Security Consulting', tin: '8802', insurance: 25 }],
  ['1026', 'Wesley', 'Tate', 'officer', 'pensacola', 'Pensacola', '850', 'w2', 21, null, 'D', { hire: '2022-12-05' }],
  ['1027', 'Denise', 'Holloway', 'officer', 'pensacola', 'Pensacola', '850', 'w2', 21.5, null, 'D', { hire: '2021-06-28' }],
  ['1028', 'Victor', 'Morales', 'officer', 'pensacola', 'Pensacola', '850', '1099', 37, null, 'G',
    { hire: '2023-03-27', business: 'Morales Protection Group LLC', tin: '2297', insurance: 300 }],

  ['1029', 'Tanisha', 'Greene', 'officer', 'harborview', 'Miami', '305', 'w2', 20, null, 'D', { hire: '2025-02-24' }],
  ['1030', 'Cody', 'Fletcher', 'officer', 'pensacola', 'Pensacola', '850', 'w2', 20, null, 'D', { hire: '2025-05-19' }],
  ['1031', 'Jasmine', 'Reed', 'officer', 'pensacola', 'Pensacola', '850', 'w2', 20.5, null, 'D', { hire: '2024-10-14' }],

  ['1032', 'Gabriel', 'Santos', 'officer', 'harborview', 'Miami', '305', 'w2', 19.5, null, 'D', { hire: '2025-08-04' }],
  ['1033', 'Priya', 'Nair', 'officer', 'harborview', 'Coral Gables', '305', 'w2', 20, null, 'D', { hire: '2024-04-08' }],
  ['1034', 'Ethan', 'Walsh', 'officer', 'bayfront', 'St. Petersburg', '727', 'w2', 19, null, 'D', { hire: '2025-11-17' }],
  ['1035', 'Olivia', 'Bennett', 'officer', 'capital', 'Tallahassee', '850', 'w2', 19.5, null, 'D', { hire: '2025-06-02' }],
  ['1036', 'Darnell', 'Hughes', 'officer', 'capital', 'Tallahassee', '850', '1099', 35, null, 'G',
    { hire: '2023-07-10', business: 'Hughes Armed Services LLC', tin: '6619', insurance: 90 }],
  ['1037', 'Chloe', 'Martin', 'officer', 'research', 'Gainesville', '352', 'w2', 19.5, null, 'D', { hire: '2025-09-08' }],
  ['1038', 'Mason', 'Clark', 'officer', 'research', 'Gainesville', '352', 'w2', 20, null, 'D', { hire: '2024-02-26' }],
  ['1039', 'Grace', 'Kim', 'officer', 'seaside', 'Ormond Beach', '386', 'w2', 19, null, 'D', { hire: '2025-12-01' }],

  ['1040', 'Jordan', 'Ellis', 'officer', 'research', 'Gainesville', '352', 'w2', 20, null, 'D', { hire: '2026-04-06' }],
  ['1041', 'Brandon', 'Moss', 'officer', 'seaside', 'Daytona Beach', '386', '1099', 26, null, 'D',
    { hire: '2026-05-11', business: 'Moss Event Staffing', tin: '1184', insurance: 400 }],
  ['1042', 'Alexis', 'Rivera', 'officer', 'capital', 'Tallahassee', '850', 'w2', 19, null, 'D', { hire: '2026-08-24' }],
  ['1043', 'Samuel', 'Ortiz', 'officer', 'pensacola', 'Pensacola', '850', 'w2', 20.5, null, 'D',
    { hire: '2023-11-06', status: 'on_leave' }],
];

const STREETS = {
  Miami: ['2140 NW 7th St', '980 SW 22nd Ave', '455 NE 62nd St', '1733 NW 17th Ave', '3021 SW 8th St', '640 NW 36th St', '1200 Brickell Bay Dr'],
  Hialeah: ['1650 W 49th St'],
  'Coral Gables': ['310 Aragon Ave'],
  'St. Petersburg': ['1250 4th St N', '3801 Central Ave', '722 22nd Ave S'],
  Tallahassee: ['1520 Thomasville Rd', '812 Ocala Rd', '2250 Apalachee Pkwy', '460 W Tennessee St', '1901 Capital Cir NE'],
  Gainesville: ['1100 NW 13th St', '3610 SW Archer Rd', '2415 NE Waldo Rd', '905 SE 4th St', '4020 NW 43rd St'],
  'Daytona Beach': ['820 Mason Ave', '1455 Beville Rd'],
  'Ormond Beach': ['275 W Granada Blvd'],
  Pensacola: ['3300 N 9th Ave', '1210 E Cervantes St', '4700 Bayou Blvd', '615 W Garden St', '2900 N Davis Hwy'],
};
const ZIPS = {
  Miami: '33125', Hialeah: '33012', 'Coral Gables': '33134', 'St. Petersburg': '33704',
  Tallahassee: '32303', Gainesville: '32608', 'Daytona Beach': '32114', 'Ormond Beach': '32174', Pensacola: '32503',
};
const EC = [
  ['Maria', 'Spouse'], ['James', 'Father'], ['Linda', 'Mother'], ['Kevin', 'Brother'], ['Ashley', 'Sister'],
  ['Robert', 'Spouse'], ['Patricia', 'Mother'], ['Michael', 'Partner'],
];
const UNIFORMS = ['S', 'M', 'L', 'XL', '2XL', 'M', 'L'];

/* ---------------------------------------------------------------- roster -- */

// Each slot is one position covered every day it is open. The primary works
// it except on `off` weekdays (0 = Sunday), when the relief does; a slot with
// no relief is closed on its off days.
const SLOTS = [
  { post: 'hvEd', start: [7, 0], hours: 8, primary: '1011', relief: '1032', off: [6, 0] },
  { post: 'hvEd', start: [15, 0], hours: 8, primary: '1012', relief: '1032', off: [2, 3] },
  { post: 'hvEd', start: [23, 0], hours: 8, primary: '1013', relief: '1033', off: [6, 0] },
  { post: 'hvGarage', start: [18, 0], hours: 12, primary: '1014', relief: '1029', off: [4, 5, 6] },
  { post: 'hvLobby', start: [7, 0], hours: 10, primary: '1015', relief: null, off: [6, 0] },
  { post: 'bmDock', start: [16, 0], hours: 8, primary: '1016', relief: '1034', off: [0, 1] },
  { post: 'bmDock', start: [0, 0], hours: 8, primary: '1017', relief: '1034', off: [3, 4] },
  { post: 'cpLobby', start: [6, 0], hours: 8, primary: '1018', relief: '1035', off: [6, 0] },
  { post: 'cpLobby', start: [14, 0], hours: 8, primary: '1019', relief: '1035', off: [2, 3] },
  { post: 'cpGarage', start: [22, 0], hours: 8, primary: '1020', relief: '1036', off: [5, 6] },
  { post: 'rpLab', start: [7, 0], hours: 8, primary: '1021', relief: '1037', off: [6, 0] },
  { post: 'rpLab', start: [15, 0], hours: 8, primary: '1022', relief: '1037', off: [2, 3] },
  { post: 'rpPatrol', start: [23, 0], hours: 8, primary: '1023', relief: '1038', off: [5, 6] },
  { post: 'soFloor', start: [10, 0], hours: 8, primary: '1024', relief: '1039', off: [1, 2] },
  { post: 'soFloor', start: [14, 0], hours: 8, primary: '1025', relief: '1039', off: [4, 5] },
  { post: 'pdGate', start: [6, 0], hours: 12, primary: '1026', relief: '1030', off: [4, 5, 6] },
  { post: 'pdGate', start: [18, 0], hours: 12, primary: '1027', relief: '1031', off: [4, 5, 6] },
  { post: 'pdWarehouse', start: [20, 0], hours: 8, primary: '1028', relief: null, off: [0] },
];

// Days relative to the seed. Approved leave moves the shift to the relief.
const TIME_OFF = [
  { code: '1016', type: 'vacation', from: 10, to: 12, status: 'approved', reason: 'Brother’s wedding in Atlanta.', note: 'Approved - Ethan covering.' },
  { code: '1027', type: 'sick', from: -6, to: -5, status: 'approved', reason: 'Stomach bug, doctor’s note provided.', note: 'Feel better. Jasmine covered both nights.' },
  { code: '1021', type: 'vacation', from: 20, to: 24, status: 'pending', reason: 'Family reunion - booked in March.', note: null },
  { code: '1034', type: 'other', from: 15, to: 15, status: 'pending', reason: 'Court date (jury service summons).', note: null },
  { code: '1038', type: 'vacation', from: 5, to: 7, status: 'denied', reason: 'Fishing trip.', note: 'Denied - two others already off that week. Please pick another week.' },
  { code: '1011', type: 'vacation', from: 30, to: 36, status: 'approved', reason: 'Annual leave.', note: 'Approved.' },
];

const INCIDENTS = [
  {
    code: '1013', post: 'hvEd', category: 'Disturbance', severity: 'high', days: -3, hour: 2, at: 'ED waiting room',
    what: 'A visitor waiting for a relative became agitated at the wait time and shoved a triage nurse against the counter at 02:10. I placed myself between them, asked him to step back, and he complied after a second request. I called a Code Grey and held the area until HPD arrived.',
    resolution: 'HPD attended at 02:24 and removed the visitor from the building. The nurse was checked by the charge doctor, no injury recorded. Visitor trespassed from the campus by hospital administration.',
    notified: 'Charge nurse, HPD, Terrence Boyd (supervisor)', police: true, policeRef: 'MPD-2026-448120', status: 'under_review',
  },
  {
    code: '1014', post: 'hvGarage', category: 'Theft', severity: 'medium', days: -6, hour: 21, at: 'Garage level 4, row F',
    what: 'A staff member reported the rear window of her car smashed and a laptop bag taken. The vehicle was parked on level 4 between 07:00 and 20:45. I reviewed camera 4-2, which shows a male on foot on level 4 at 19:12 but does not cover row F.',
    resolution: 'Area photographed, staff member assisted with a police report, footage exported for MPD. Extra walk of level 4 added for the rest of the week.',
    notified: 'MPD non-emergency, Carla Mendez (client)', police: true, policeRef: 'MPD-2026-447002', cost: 0, status: 'closed',
  },
  {
    code: '1016', post: 'bmDock', category: 'Maintenance Issue', severity: 'medium', days: -2, hour: 18, at: 'Pier C, slip 14',
    what: 'On the evening walk I found the 38ft vessel in slip C-14 riding noticeably low at the stern with its bilge alarm sounding. The owner was not on site.',
    resolution: 'Called the dockmaster, who reached the owner and started the dock pump. Vessel stabilised by 19:10. No fuel sheen on the water.',
    notified: 'Dockmaster, Graham Whitlock (client)', status: 'closed',
  },
  {
    code: '1020', post: 'cpGarage', category: 'Trespass', severity: 'medium', days: -4, hour: 1, at: 'Garage level P3 (closed overnight)',
    what: 'Found two individuals sleeping in the P3 stairwell during the 01:00 walk. Both were cooperative. Neither was a tenant or visitor.',
    resolution: 'Advised both that the garage is private property and closed overnight, and gave them the address of the shelter on Tennessee St. Both left on foot at 01:20. Stairwell door latch found faulty and reported.',
    notified: 'Megan Hollis (supervisor), building engineer', status: 'closed',
  },
  {
    code: '1018', post: 'cpLobby', category: 'Access Control', severity: 'low', days: -1, hour: 9, at: 'Main turnstiles',
    what: 'A visitor for the 15th floor state agency arrived without pre-registration and insisted he had an appointment. I contacted the agency reception, who could not confirm it.',
    resolution: 'Visitor was not admitted. Agency reception later confirmed the appointment was for the following week. Visitor left without incident.',
    notified: 'Agency reception', status: 'submitted',
  },
  {
    code: '1021', post: 'rpLab', category: 'Alarm / System', severity: 'high', days: -5, hour: 11, at: 'Ground floor freezer alarm panel',
    what: 'The freezer alarm panel showed red on ULT freezer 7 at 11:05. Panel reading -58C and rising against a -80C setpoint.',
    resolution: 'Called the on-call researcher, who arrived at 11:19 and moved samples to the backup freezer. Facilities attended; compressor failure confirmed. No samples lost.',
    notified: 'On-call researcher, facilities, Dr. Anil Rao (client)', status: 'closed',
  },
  {
    code: '1023', post: 'rpPatrol', category: 'Suspicious Activity', severity: 'medium', days: -8, hour: 3, at: 'Building D loading dock',
    what: 'Patrol found the building D loading dock roller door open about two feet at 03:12. No one in the area. Nothing appeared disturbed inside the dock.',
    resolution: 'Walked the interior of the dock and the corridor to the freight lift. Door closed and secured. Door sensor found to be out of alignment, which is why no alarm was raised.',
    notified: 'Campus police dispatch, facilities', status: 'closed',
  },
  {
    code: '1025', post: 'soFloor', category: 'Theft', severity: 'medium', days: -2, hour: 16, at: 'East wing, footwear store',
    what: 'Store manager reported two teenagers leaving with unpaid sneakers. I observed them from the concourse and followed at a distance to the north exit, where they left in a silver sedan. Plate recorded.',
    resolution: 'Plate and descriptions passed to DBPD and the store. No contact made with the subjects, per post orders.',
    notified: 'DBPD, store manager', police: true, policeRef: 'DBPD-2026-30917', cost: 38000, status: 'under_review',
  },
  {
    code: '1024', post: 'soFloor', category: 'Other', severity: 'low', days: -9, hour: 13, at: 'Food court',
    what: 'A four-year-old boy was found alone and crying near the carousel. I stayed with him and took him to guest services as the post orders say.',
    resolution: 'Parent paged without using the child’s name and reunited at guest services within six minutes.',
    notified: 'Guest services', status: 'closed',
  },
  {
    code: '1026', post: 'pdGate', category: 'Vehicle Incident', severity: 'medium', days: -3, hour: 8, at: 'Inbound gate lane 2',
    what: 'Inbound driver presented a bill of lading whose seal number did not match the seal on the trailer. Driver said the shipper resealed after an inspection.',
    resolution: 'Truck held at the gate and receiving supervisor called. Shipper confirmed the reseal by email with photos. Truck admitted at 08:55 with both seal numbers logged.',
    notified: 'Receiving supervisor, Russell Pike (client)', status: 'closed',
  },
  {
    code: '1028', post: 'pdWarehouse', category: 'Access Control', severity: 'high', days: -1, hour: 22, at: 'High-value cage',
    what: 'A single warehouse lead requested access to the high-value cage at 22:40 to pull an urgent order. Two-person rule requires a second named staff member. None available on shift.',
    resolution: 'Access refused. Operations manager called and authorised the order to wait until the 06:00 shift. Logged per post orders.',
    notified: 'Operations manager, Megan Hollis (supervisor)', status: 'submitted',
  },
];

/* ============================================================== the run === */

export async function seedExpansion(ctx) {
  const {
    db, at, toSql, hashPin, hashPassword, raiseFlag, buildTour, buildLines, nextNumber,
    invoiceTotals, toDateString, users: original, year,
  } = ctx;
  const rand = mulberry32(20260925);
  const now = new Date();

  const batchInsert = async (table, columns, rows, chunk = 300) => {
    const ids = [];
    for (let i = 0; i < rows.length; i += chunk) {
      const part = rows.slice(i, i + chunk);
      const values = part.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
      const res = await db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values}`).run(...part.flat());
      ids.push(...(res.rows || []).map((r) => r.id));
    }
    return ids;
  };

  /* -------------------------------------------------------- sites/posts -- */
  const siteIds = {};
  const posts = {};
  for (const site of SITES) {
    const id = Number((await db.prepare(
      `INSERT INTO sites (name, client_name, address, city, state, postal_code, latitude, longitude,
                          contact_name, contact_phone, contact_email)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(site.name, site.client, site.address, site.city, 'FL', site.zip, site.lat, site.lng, ...site.contact)).lastInsertRowid);
    siteIds[site.key] = id;

    for (const p of site.posts) {
      const [lat, lng] = offsetPoint(site.lat, site.lng, Math.hypot(p.dx, p.dy), Math.atan2(p.dy, p.dx));
      const postId = Number((await db.prepare(
        `INSERT INTO posts (site_id, name, post_code, instructions, address, latitude, longitude,
                            geofence_radius_m, check_in_interval_min, requires_gps, armed, bill_rate_cents)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(id, p.name, p.code, p.instructions.join('\n'), `${site.address}, ${site.city}`, lat, lng,
        p.radius, p.interval === RULES.defaultCheckInIntervalMinutes ? null : p.interval, true, p.armed, p.bill)).lastInsertRowid);
      posts[p.key] = { id: postId, siteId: id, siteKey: site.key, latitude: lat, longitude: lng,
        geofence_radius_m: p.radius, interval: p.interval, armed: p.armed, name: p.name, code: p.code };
    }
  }

  /* ---------------------------------------------------------------- staff -- */
  const staff = {};
  const pins = {};
  for (const [i, row] of STAFF.entries()) {
    const [code, first, last, role, siteKey, city, area, type, rate, bill, lic, extra] = row;
    const pin = String(((Number(code) * 7919) % 9000) + 1000);
    const { hash, salt } = hashPin(pin);
    const streets = STREETS[city];
    const [ecFirst, ecRel] = EC[i % EC.length];
    const contractor = type === '1099';
    const armed = lic === 'G';
    const licExpires = new Date(now);
    licExpires.setDate(licExpires.getDate() + 200 + ((i * 97) % 600));
    // A couple of licences inside the warning window so the licensing board has work.
    if (code === '1036') licExpires.setTime(now.getTime() + 21 * 86400000);
    if (code === '1022') licExpires.setTime(now.getTime() + 44 * 86400000);
    const insurance = extra.insurance != null ? new Date(now.getTime() + extra.insurance * 86400000) : null;

    const id = Number((await db.prepare(
      `INSERT INTO users
       (employee_code, first_name, last_name, email, phone, role, status, hire_date,
        license_number, license_type, license_expires_on, emergency_contact_name,
        emergency_contact_phone, emergency_contact_relation, default_site_id,
        pay_rate_cents, bill_rate_cents, employment_type, pay_type, exempt, overtime_multiplier,
        business_name, tax_id_last4, w9_on_file, contractor_agreement_on_file, insurance_expires_on,
        address_line1, city, state, postal_code, uniform_size, pin_hash, pin_salt, pin_set_at, must_change_pin)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,now(),?)`
    ).run(
      code, first, last,
      contractor ? `${first[0].toLowerCase()}.${last.toLowerCase()}@contractor.example` : `${first[0].toLowerCase()}.${last.toLowerCase()}@usasecuritygroup.com`,
      `(${area}) 555-${String(200 + i).padStart(4, '0')}`,
      role, extra.status || 'active', extra.hire,
      `${lic}-${3600000 + i * 7919}`, armed ? 'Class G (Armed)' : 'Class D', toDateString(licExpires),
      `${ecFirst} ${last}`, `(${area}) 555-${String(700 + i).padStart(4, '0')}`, ecRel,
      siteIds[siteKey],
      Math.round(rate * 100), bill ? Math.round(bill * 100) : null,
      type, 'hourly', false, 1.5,
      extra.business || null, extra.tin || null, contractor, contractor,
      insurance ? toDateString(insurance) : null,
      streets[i % streets.length], city, 'FL', ZIPS[city], UNIFORMS[i % UNIFORMS.length],
      hash, salt, false
    )).lastInsertRowid);
    staff[code] = { id, code, name: `${first} ${last}`, first, last, role, type, rate, armed, siteKey, city };
    pins[code] = pin;
  }
  const supervisorSouth = staff['1009'].id;
  const supervisorNorth = staff['1010'].id;
  const supervisorFor = (siteKey) =>
    ['harborview', 'bayfront', 'seaside'].includes(siteKey) ? supervisorSouth : supervisorNorth;

  /* ------------------------------------------------------ pay history -- */
  // Everybody gets a starting rate; anyone here before this year also gets
  // the January review, so the history screen has a story in it.
  const everyone = await db.prepare(
    `SELECT id, hire_date, employment_type, pay_type, pay_rate_cents, salary_cents, bill_rate_cents,
            overtime_multiplier FROM users`
  ).all();
  const historyRows = [];
  for (const u of everyone) {
    const hired = String(u.hire_date || '2024-01-01');
    const contractor = u.employment_type === '1099';
    if (u.pay_type === 'hourly' && u.pay_rate_cents && hired < '2026-01-01') {
      const step = contractor ? 150 : 75;
      historyRows.push([u.id, hired, u.employment_type, u.pay_type, u.pay_rate_cents - step, u.salary_cents,
        u.bill_rate_cents, u.overtime_multiplier, contractor ? 'Contract rate agreed' : 'Starting rate', original.admin]);
      historyRows.push([u.id, '2026-01-05', u.employment_type, u.pay_type, u.pay_rate_cents, u.salary_cents,
        u.bill_rate_cents, u.overtime_multiplier, contractor ? 'Rate renegotiated at contract renewal' : 'Annual review - merit increase', original.admin]);
    } else {
      historyRows.push([u.id, hired, u.employment_type, u.pay_type, u.pay_rate_cents, u.salary_cents,
        u.bill_rate_cents, u.overtime_multiplier, contractor ? 'Contract rate agreed' : 'Starting rate', original.admin]);
    }
  }
  await batchInsert('pay_rate_history',
    ['user_id', 'effective_on', 'employment_type', 'pay_type', 'pay_rate_cents', 'salary_cents',
      'bill_rate_cents', 'overtime_multiplier', 'reason', 'changed_by'], historyRows);

  /* ------------------------------------------- keys and equipment ------ */

  // Every site gets radios and a key ring; armed posts get a weapon in the
  // locker; two sites get a patrol vehicle, which is the case that does NOT
  // come back at the end of a shift.
  const equipmentRows = [];
  for (const site of SITES) {
    const siteId = siteIds[site.key];
    equipmentRows.push([siteId, 'radio', `Radio ${site.key.slice(0, 2).toUpperCase()}-1`, `RAD-${siteId}01`, null, true, false, 'available']);
    equipmentRows.push([siteId, 'radio', `Radio ${site.key.slice(0, 2).toUpperCase()}-2`, `RAD-${siteId}02`, null, true, false, 'available']);
    equipmentRows.push([siteId, 'keys', `${site.name} master ring`, `KEY-${siteId}`, 'Do not duplicate. Signed out one ring at a time.', true, false, 'available']);
  }

  const armedPostSites = await db
    .prepare(`SELECT DISTINCT s.id, s.name FROM posts p JOIN sites s ON s.id = p.site_id WHERE p.armed = true`)
    .all();
  for (const site of armedPostSites) {
    equipmentRows.push([site.id, 'weapon', `Duty firearm - ${site.name}`, `FA-${site.id}`,
      'Class G required. Logged out at shift start and back into the locker at shift end.', true, true, 'available']);
  }

  // A vehicle is assigned for a stretch, not a shift, so it is deliberately not
  // return_by_end_of_shift - otherwise every patrol driver would be flagged
  // every night for a van that is meant to stay with them.
  const vehicleSites = armedPostSites.slice(0, 2);
  for (const site of vehicleSites) {
    equipmentRows.push([site.id, 'vehicle', `Patrol vehicle - ${site.name}`, `VEH-${site.id}`,
      'Mileage logged at handover. Fuel card in the glovebox.', false, false, 'available']);
  }

  // One spare radio belonging to nobody, to prove a company-wide item works.
  equipmentRows.push([null, 'radio', 'Spare radio (pool)', 'RAD-POOL-1', 'Kept at head office.', true, false, 'available']);

  await batchInsert('equipment',
    ['site_id', 'category', 'label', 'identifier', 'notes', 'return_by_end_of_shift', 'armed_only', 'status'],
    equipmentRows);

  /* --------------------------------------------- post differentials ---- */

  // Armed posts pay more than the officers standing them earn elsewhere, and
  // keep paying it whoever is rostered on. Seeded against the post rather than
  // the person so a report shows the armed premium as a property of the yard,
  // which is what an operations manager is actually deciding about.
  const armedPosts = await db
    .prepare(`SELECT id, name FROM posts WHERE armed = 1 ORDER BY id`)
    .all();
  const differentialRows = armedPosts.map((post) => [
    post.id,
    null,
    '2026-01-05',
    4150,
    1.5,
    'Armed post differential - Class G required',
    original.admin,
  ]);
  await batchInsert('post_pay_rates',
    ['post_id', 'user_id', 'effective_on', 'pay_rate_cents', 'overtime_multiplier', 'reason', 'changed_by'],
    differentialRows);

  /* ----------------------------------------------------------- time off -- */
  const onLeave = (code, date) =>
    TIME_OFF.some((t) => t.code === code && t.status === 'approved' &&
      date >= at(t.from, 0) && date < at(t.to + 1, 0));
  for (const t of TIME_OFF) {
    await db.prepare(
      `INSERT INTO time_off_requests (user_id, type, starts_on, ends_on, reason, status, decided_by, decided_at, decision_note)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      staff[t.code].id, t.type, toDateString(at(t.from, 0)), toDateString(at(t.to, 0)), t.reason, t.status,
      t.status === 'pending' ? null : supervisorFor(staff[t.code].siteKey),
      t.status === 'pending' ? null : toSql(at(Math.min(t.from - 3, -1), 10)),
      t.note
    );
  }

  /* ------------------------------------------------------------ shifts -- */
  const plan = [];
  for (const [slotIndex, slot] of SLOTS.entries()) {
    for (let day = -15; day <= 14; day++) {
      const starts = at(day, slot.start[0], slot.start[1]);
      const ends = new Date(starts.getTime() + slot.hours * HOUR);
      const weekday = starts.getDay();
      let code = slot.off.includes(weekday) ? slot.relief : slot.primary;
      if (!code) continue;
      if (onLeave(code, starts)) code = code === slot.primary ? slot.relief : null;
      // A scatter of future shifts left open for officers to claim. Kept to
      // day 8 onwards so the original suite's open shifts still come first.
      const open = day >= 9 && day <= 12 && (slotIndex * 3 + day) % 7 === 0;
      plan.push({ slot, slotIndex, day, starts, ends, code: open ? null : code, post: posts[slot.post] });
    }
  }

  const specials = [
    { post: 'rpLab', code: '1040', starts: new Date(now.getTime() - 18 * MINUTE), hours: 8,
      notes: 'Additional coverage: lab relocation, movers on site.', kind: 'late' },
    { post: 'soFloor', code: '1041', starts: new Date(now.getTime() - 70 * MINUTE), hours: 6,
      notes: 'Additional coverage requested by mall management.', kind: 'no_show' },
    { post: 'bmDock', code: null, starts: new Date(now.getTime() - 40 * MINUTE), hours: 4,
      notes: 'Boat show overflow parking - cover needed.', kind: 'uncovered' },
    { post: 'hvEd', code: null, starts: at(9, 18), hours: 8, notes: 'Hospital foundation gala - extra officer at the ED doors.' },
    { post: 'soFloor', code: null, starts: at(10, 12), hours: 8, notes: 'Weekend sale - extra floor patrol.' },
    { post: 'pdWarehouse', code: null, starts: at(11, 20), hours: 8, notes: 'Quarter-end inventory count - second armed officer.' },
    { post: 'cpLobby', code: null, starts: at(12, 8), hours: 8, notes: 'Legislative committee week - visitor surge.' },
  ].filter((s) => posts[s.post]);

  const insertShift = db.prepare(
    `INSERT INTO shifts (user_id, post_id, starts_at, ends_at, status, notes, is_open, created_by)
     VALUES (?,?,?,?,?,?,?,?)`
  );

  const worked = [];
  const live = [];
  let noShowCount = 0;
  for (const p of plan) {
    const past = p.ends <= now;
    const running = p.starts <= now && p.ends > now;
    // A handful of past shifts nobody turned up for. Left 'scheduled' so the
    // compliance sweep marks them missed and raises the flag, as it would.
    const noShow = past && p.code && p.day <= -2 && (p.slotIndex * 31 + p.day * 7 + 200) % 83 === 0;
    if (noShow) noShowCount += 1;
    const status = !p.code ? 'scheduled' : noShow ? 'scheduled' : past ? 'completed' : running ? 'in_progress' : 'scheduled';
    const id = Number((await insertShift.run(
      p.code ? staff[p.code].id : null, p.post.id, toSql(p.starts), toSql(p.ends), status, null,
      !p.code, original.admin
    )).lastInsertRowid);
    if (!p.code || noShow) continue;
    const item = { ...p, shiftId: id, user: staff[p.code] };
    if (past) worked.push(item);
    else if (running) live.push(item);
  }

  const specialRows = [];
  for (const s of specials) {
    const ends = new Date(s.starts.getTime() + s.hours * HOUR);
    const id = Number((await insertShift.run(
      s.code ? staff[s.code].id : null, posts[s.post].id, toSql(s.starts), toSql(ends), 'scheduled', s.notes,
      !s.code, original.admin
    )).lastInsertRowid);
    specialRows.push({ ...s, id });
  }

  /* ---------------------------------------------------- worked shifts -- */
  const insertEntry = db.prepare(
    `INSERT INTO time_entries
     (user_id, shift_id, post_id, clock_in_at, clock_in_lat, clock_in_lng, clock_in_accuracy,
      clock_in_geofence, clock_in_distance_m, clock_out_at, clock_out_lat, clock_out_lng,
      clock_out_accuracy, clock_out_geofence, method, device_id, minutes_worked, late_minutes,
      unpaid_break_minutes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  const fenceOf = (post, lat, lng, accuracy) =>
    evaluateGeofence({ lat, lng, accuracy, post });

  /** Where an officer stands at minute m of a shift at this post. */
  const positionAt = (post, m, seed) => {
    const patrol = post.geofence_radius_m >= 200;
    if (patrol) {
      const angle = (m / 40) * Math.PI * 2 + seed;
      return offsetPoint(post.latitude, post.longitude, post.geofence_radius_m * (0.35 + 0.25 * Math.sin(m / 17 + seed)), angle);
    }
    return offsetPoint(post.latitude, post.longitude, 6 + rand() * 22, rand() * Math.PI * 2);
  };

  const pingRows = [];
  const pingColumns = ['user_id', 'time_entry_id', 'post_id', 'recorded_at', 'latitude', 'longitude',
    'accuracy', 'speed_mps', 'heading', 'source', 'geofence', 'distance_m'];
  const addPing = (userId, entryId, post, when, lat, lng, accuracy, source, speed = null) => {
    const f = fenceOf(post, lat, lng, accuracy);
    pingRows.push([userId, entryId, post.id, toSql(when), lat, lng, accuracy, speed, null, source, f.status, f.distance ?? null]);
    return f;
  };

  const checkRows = [];
  const missedChecks = [];
  const breakRows = [];
  const pingCutoff = new Date(now.getTime() - 8 * 86400000);
  let k = 0;
  let walkOffs = 0;

  for (const w of worked) {
    k += 1;
    const post = w.post;
    const late = k % 11 === 4 ? 9 + (k % 12) : 0;
    const outside = k % 23 === 7;
    const early = k % 29 === 11 ? 25 + (k % 15) : 0;
    const clockIn = new Date(w.starts.getTime() + (late ? late + RULES.lateGraceMinutes : -(1 + (k % 6))) * MINUTE);
    const clockOut = new Date(w.ends.getTime() + (early ? -early : (k % 7) - 2) * MINUTE);
    const [inLat, inLng] = outside
      ? offsetPoint(post.latitude, post.longitude, post.geofence_radius_m + 180 + (k % 5) * 60, k)
      : positionAt(post, 0, k);
    const inAcc = 5 + (k % 9);
    const inFence = fenceOf(post, inLat, inLng, inAcc);
    const [outLat, outLng] = positionAt(post, 1, k + 1);
    const minutes = Math.round((clockOut - clockIn) / MINUTE);
    const breakMinutes = minutes >= 7 * 60 ? 30 : 0;

    const entryId = Number((await insertEntry.run(
      w.user.id, w.shiftId, post.id, toSql(clockIn), inLat, inLng, inAcc, inFence.status, inFence.distance,
      toSql(clockOut), outLat, outLng, 6, fenceOf(post, outLat, outLng, 6).status,
      k % 5 === 0 ? 'nfc' : 'gps', `demo-device-${w.user.code}`, minutes, late, breakMinutes
    )).lastInsertRowid);

    if (late) {
      await raiseFlag({ userId: w.user.id, type: 'late_clock_in', occurredAt: clockIn, refType: 'time_entry',
        refId: entryId, detail: { late_minutes: late, scheduled_start: w.starts.toISOString() } });
    }
    if (outside) {
      await raiseFlag({ userId: w.user.id, type: 'geofence_violation', occurredAt: clockIn, refType: 'time_entry',
        refId: entryId, detail: { distance_m: inFence.distance, radius_m: post.geofence_radius_m, status: 'outside',
          reason: 'Traffic on the causeway - clocked in from the car park entrance.' } });
    }
    if (early) {
      await raiseFlag({ userId: w.user.id, type: 'early_departure', occurredAt: clockOut, refType: 'time_entry',
        refId: entryId, detail: { early_by_minutes: early, scheduled_end: w.ends.toISOString() } });
    }

    if (breakMinutes) {
      const bStart = new Date(clockIn.getTime() + Math.round(minutes * 0.5) * MINUTE);
      const [bLat, bLng] = positionAt(post, 2, k + 2);
      breakRows.push([entryId, w.user.id, 'meal', false, toSql(bStart), toSql(new Date(bStart.getTime() + 30 * MINUTE)), 30, bLat, bLng]);
    }

    // Status check-ins at the post's cadence: nearly always answered.
    if (clockIn > new Date(now.getTime() - 15 * 86400000)) {
      for (let due = new Date(clockIn.getTime() + post.interval * MINUTE); due < clockOut; due = new Date(due.getTime() + post.interval * MINUTE)) {
        const roll = (k * 13 + due.getHours() * 7) % 97;
        if (roll === 3) {
          missedChecks.push({ entryId, userId: w.user.id, due });
          continue;
        }
        const lateAnswer = roll === 50;
        const [cLat, cLng] = positionAt(post, due.getMinutes(), k);
        checkRows.push([entryId, w.user.id, toSql(due), RULES.checkInWindowMinutes,
          toSql(new Date(due.getTime() + (lateAnswer ? 14 : 1 + (roll % 6)) * MINUTE)),
          lateAnswer ? 'late' : 'ok', cLat, cLng]);
      }
    }

    // GPS trail for the last week, every quarter hour.
    if (clockIn > pingCutoff) {
      addPing(w.user.id, entryId, post, clockIn, inLat, inLng, inAcc, 'clock_in');
      const walkOffAt = k % 19 === 3 ? Math.round(minutes * 0.6) : null;
      for (let m = 15; m < minutes; m += 15) {
        const when = new Date(clockIn.getTime() + m * MINUTE);
        if (walkOffAt != null && m >= walkOffAt && m < walkOffAt + 30) {
          const [oLat, oLng] = offsetPoint(post.latitude, post.longitude, post.geofence_radius_m * (1.7 + (m - walkOffAt) / 30), k);
          addPing(w.user.id, entryId, post, when, oLat, oLng, 9, 'watch', 1.3);
          // The flag references the first ping outside. Ids only exist after
          // the batch insert, so mark the row and raise the flag afterwards.
          if (m - walkOffAt < 15) {
            walkOffs += 1;
            pingRows[pingRows.length - 1].walkOff = { userId: w.user.id, entryId, when, radius: post.geofence_radius_m };
          }
          continue;
        }
        const [lat, lng] = positionAt(post, m, k);
        const accuracy = (k + m) % 53 === 0 ? 140 : 4 + ((k + m) % 12);
        addPing(w.user.id, entryId, post, when, lat, lng, accuracy, 'watch', post.geofence_radius_m >= 200 ? 1.1 : 0.2);
      }
      addPing(w.user.id, entryId, post, clockOut, outLat, outLng, 6, 'clock_out');
    }
  }

  /* ------------------------------------------- the originals' trails -- */
  // The first four sites were seeded without GPS history. Give their last
  // week the same trail so the GPS report is not blank for half the company.
  const originals = await db.prepare(
    `SELECT te.id, te.user_id, te.post_id, te.clock_in_at, te.clock_out_at, te.clock_in_lat, te.clock_in_lng,
            p.latitude, p.longitude, p.geofence_radius_m
     FROM time_entries te JOIN posts p ON p.id = te.post_id
     WHERE te.clock_in_at >= ? AND te.user_id = ANY(?::int[])`
  ).all(toSql(pingCutoff), `{${Object.values(original).join(',')}}`);
  for (const [i, e] of originals.entries()) {
    const post = { id: e.post_id, latitude: e.latitude, longitude: e.longitude, geofence_radius_m: e.geofence_radius_m };
    const clockIn = new Date(e.clock_in_at);
    // An entry still open is somebody on post now: trail them up to a minute ago.
    const clockOut = e.clock_out_at ? new Date(e.clock_out_at) : new Date(now.getTime() - MINUTE);
    addPing(e.user_id, e.id, post, clockIn, e.clock_in_lat, e.clock_in_lng, 8, 'clock_in');
    for (let t = clockIn.getTime() + 15 * MINUTE; t < clockOut.getTime(); t += 15 * MINUTE) {
      const [lat, lng] = positionAt(post, (t - clockIn.getTime()) / MINUTE, i);
      addPing(e.user_id, e.id, post, new Date(t), lat, lng, 5 + (i % 9), 'watch');
    }
    addPing(e.user_id, e.id, post, clockOut, e.latitude, e.longitude, 7, e.clock_out_at ? 'clock_out' : 'watch');
  }

  /* ------------------------------------------------------ on duty now -- */
  // A shift still running holds its pay period open, so on a Monday morning an
  // overnight shift that began on Sunday would keep last week from closing.
  // Like Marcus's shift, which never starts before today, the live shifts here
  // never start before ten past midnight on the Monday of this payroll week,
  // and nobody clocks in before that Monday (officers punch in a few minutes
  // early, so a shift starting at midnight would otherwise begin on Sunday).
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const earliestStart = new Date(weekStart.getTime() + 10 * MINUTE);
  for (const l of live) {
    if (l.starts >= earliestStart) continue;
    l.starts = earliestStart;
    await db.prepare(`UPDATE shifts SET starts_at = ? WHERE id = ?`).run(toSql(l.starts), l.shiftId);
  }

  // Earliest starters first, so the three set pieces go to people who have
  // been on post long enough for them to make sense.
  live.sort((a, b) => a.starts - b.starts);
  const scenarios = ['off_post', 'on_break', 'gps_stale'];
  const liveSummary = [];
  for (const [i, l] of live.entries()) {
    const post = l.post;
    const scenario = scenarios[i] || (i === 3 ? 'late_in' : 'normal');
    const lateBy = scenario === 'late_in' ? 13 : 0;
    const clockIn = new Date(Math.max(weekStart.getTime(), Math.min(
      l.starts.getTime() + (lateBy ? lateBy + RULES.lateGraceMinutes : -(2 + (i % 4))) * MINUTE,
      now.getTime() - 2 * MINUTE
    )));
    const [inLat, inLng] = positionAt(post, 0, i + 40);
    const inFence = fenceOf(post, inLat, inLng, 7);
    const entryId = Number((await insertEntry.run(
      l.user.id, l.shiftId, post.id, toSql(clockIn), inLat, inLng, 7, inFence.status, inFence.distance,
      null, null, null, null, null, 'gps', `demo-device-${l.user.code}`, null, lateBy, 0
    )).lastInsertRowid);
    if (lateBy) {
      await raiseFlag({ userId: l.user.id, type: 'late_clock_in', occurredAt: clockIn, refType: 'time_entry',
        refId: entryId, detail: { late_minutes: lateBy, scheduled_start: l.starts.toISOString() } });
    }

    addPing(l.user.id, entryId, post, clockIn, inLat, inLng, 7, 'clock_in');
    const lastPing = scenario === 'gps_stale' ? now.getTime() - 38 * MINUTE : now.getTime() - MINUTE;
    const leaveAt = scenario === 'off_post' ? now.getTime() - 16 * MINUTE : Infinity;
    for (let t = clockIn.getTime() + 5 * MINUTE; t <= lastPing; t += 5 * MINUTE) {
      const m = (t - clockIn.getTime()) / MINUTE;
      if (t >= leaveAt) {
        const [oLat, oLng] = offsetPoint(post.latitude, post.longitude,
          post.geofence_radius_m + 60 + ((t - leaveAt) / MINUTE) * 14, 0.9);
        addPing(l.user.id, entryId, post, new Date(t), oLat, oLng, 8, 'watch', 1.4);
        if (!pingRows.some((r) => r.walkOff?.entryId === entryId)) {
          pingRows[pingRows.length - 1].walkOff = { userId: l.user.id, entryId, when: new Date(t), radius: post.geofence_radius_m };
        }
        continue;
      }
      const [lat, lng] = positionAt(post, m, i + 40);
      addPing(l.user.id, entryId, post, new Date(t), lat, lng, 4 + (i % 8), 'watch', post.geofence_radius_m >= 200 ? 1.1 : 0.1);
    }

    // Check-ins answered up to now, one missed for the officer who went
    // quiet, and the next one queued.
    let due = new Date(clockIn.getTime() + post.interval * MINUTE);
    for (; due.getTime() + RULES.checkInWindowMinutes * MINUTE < now.getTime(); due = new Date(due.getTime() + post.interval * MINUTE)) {
      if (scenario === 'gps_stale' && due.getTime() > now.getTime() - 38 * MINUTE) {
        missedChecks.push({ entryId, userId: l.user.id, due });
        continue;
      }
      const [cLat, cLng] = positionAt(post, (due - clockIn) / MINUTE, i + 40);
      checkRows.push([entryId, l.user.id, toSql(due), RULES.checkInWindowMinutes,
        toSql(new Date(due.getTime() + 2 * MINUTE)), 'ok', cLat, cLng]);
    }
    checkRows.push([entryId, l.user.id, toSql(due), RULES.checkInWindowMinutes, null, 'pending', null, null]);

    if (scenario === 'on_break') {
      const [bLat, bLng] = positionAt(post, 0, i + 41);
      await db.prepare(
        `INSERT INTO breaks (time_entry_id, user_id, type, paid, started_at, start_lat, start_lng) VALUES (?,?,?,?,?,?,?)`
      ).run(entryId, l.user.id, 'meal', false, toSql(new Date(now.getTime() - 14 * MINUTE)), bLat, bLng);
    }
    liveSummary.push(`${l.user.name} (${l.user.code}) at ${post.name}${scenario !== 'normal' ? ` - ${scenario.replace('_', ' ')}` : ''}`);
  }

  /* -------------------------------------------------- write the bulk -- */
  const pingIds = await batchInsert('location_pings', pingColumns, pingRows.map((r) => r.slice(0, 12)));
  for (const [i, r] of pingRows.entries()) {
    if (!r.walkOff) continue;
    await raiseFlag({
      userId: r.walkOff.userId, type: 'off_post', occurredAt: r.walkOff.when, refType: 'location_ping',
      refId: pingIds[i], detail: { distance_m: r[11], radius_m: r.walkOff.radius, time_entry_id: r.walkOff.entryId },
    });
  }

  await batchInsert('status_checks',
    ['time_entry_id', 'user_id', 'due_at', 'window_minutes', 'responded_at', 'status', 'latitude', 'longitude'], checkRows);
  for (const m of missedChecks) {
    const id = Number((await db.prepare(
      `INSERT INTO status_checks (time_entry_id, user_id, due_at, window_minutes, status) VALUES (?,?,?,?,'missed')`
    ).run(m.entryId, m.userId, toSql(m.due), RULES.checkInWindowMinutes)).lastInsertRowid);
    await raiseFlag({ userId: m.userId, type: 'missed_check_in', occurredAt: m.due, refType: 'status_check', refId: id,
      detail: { due_at: m.due.toISOString(), answered: false } });
  }
  await batchInsert('breaks',
    ['time_entry_id', 'user_id', 'type', 'paid', 'started_at', 'ended_at', 'minutes', 'start_lat', 'start_lng'], breakRows);

  // Old flags have been dealt with; the last few days are still open.
  const RESOLUTIONS = {
    late_clock_in: 'Spoke with the officer. Traffic accident on the route - documented, no further action.',
    geofence_violation: 'Reviewed with the officer: clocked in from the far side of the car park. Reminded to clock in at the post.',
    early_departure: 'Relief arrived early and the handover was agreed with the site contact. OK.',
    missed_check_in: 'Officer was dealing with a visitor at the time. Called and confirmed safe within five minutes.',
    off_post: 'Officer was escorting a staff member to their car. Legitimate - asked to radio it in next time.',
  };
  for (const [type, note] of Object.entries(RESOLUTIONS)) {
    await db.prepare(
      `UPDATE flags SET resolved_at = occurred_at + interval '20 hours', resolved_by = ?, resolution_note = ?
       WHERE type = ? AND resolved_at IS NULL AND occurred_at < ? AND user_id = ANY(?::int[])`
    ).run(supervisorNorth, note, type, toSql(new Date(now.getTime() - 3 * 86400000)),
      `{${Object.values(staff).map((s) => s.id).join(',')}}`);
  }

  /* --------------------------------- who is holding what right now ---- */
  // Runs here, not beside the inventory above: time entries do not exist
  // until later in this file, so asking earlier who is on duty returns
  // nobody and every item stays on the shelf.
  // Hand items to the officers who are actually on duty now, so the inventory
  // is not uniformly "available" - which would show nothing.
  const allEquipment = await db.prepare(`SELECT * FROM equipment ORDER BY id`).all();
  const onDutyNow = await db
    .prepare(
      `SELECT te.id AS entry_id, te.user_id, p.site_id
       FROM time_entries te JOIN posts p ON p.id = te.post_id
       WHERE te.clock_out_at IS NULL`
    )
    .all();

  const assignmentRows = [];
  const takenIds = new Set();
  for (const duty of onDutyNow) {
    const radio = allEquipment.find(
      (e) => e.site_id === duty.site_id && e.category === 'radio' && !takenIds.has(e.id)
    );
    if (radio) {
      takenIds.add(radio.id);
      assignmentRows.push([radio.id, duty.user_id, duty.entry_id, toSql(at(0, 6)), original.admin, 'good', null]);
    }
  }

  // And one that went home in somebody's pocket three days ago: an officer who
  // has long since clocked out, still holding a site's master keys. That is the
  // row the whole feature exists to surface.
  const strayHolder = await db
    .prepare(
      `SELECT u.id FROM users u
       WHERE u.status = 'active' AND u.role = 'officer'
         AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.user_id = u.id AND te.clock_out_at IS NULL)
       ORDER BY u.id LIMIT 1`
    )
    .get();
  const strayKeys = allEquipment.find((e) => e.category === 'keys');
  if (strayHolder && strayKeys) {
    takenIds.add(strayKeys.id);
    assignmentRows.push([strayKeys.id, strayHolder.id, null, toSql(at(-3, 18)), original.admin, 'good',
      'Relief handover - said he would drop them back in the morning.']);
  }

  await batchInsert('equipment_assignments',
    ['equipment_id', 'user_id', 'time_entry_id', 'issued_at', 'issued_by', 'issued_condition', 'issued_note'],
    assignmentRows);

  if (takenIds.size) {
    await db.prepare(
      `UPDATE equipment SET status = 'issued' WHERE id IN (${[...takenIds].map(() => '?').join(',')})`
    ).run(...takenIds);
  }

  // One radio away being repaired, so the inventory has a third state in it.
  const forRepair = allEquipment.find((e) => e.category === 'radio' && !takenIds.has(e.id));
  if (forRepair) {
    await db.prepare(`UPDATE equipment SET status = 'maintenance' WHERE id = ?`).run(forRepair.id);
  }

  /* ----------------------------------------------------- availability -- */
  const availRows = [];
  for (const s of Object.values(staff)) {
    for (let weekday = 0; weekday <= 6; weekday++) {
      const student = ['1024', '1037', '1042'].includes(s.code) && (weekday === 2 || weekday === 4);
      const church = s.code === '1018' && weekday === 0;
      availRows.push([s.id, weekday, '00:00', student ? '16:00' : '23:59', !church,
        church ? 'Church and family - Sundays off please' : student ? 'Evening classes' : null]);
    }
  }
  await batchInsert('availability', ['user_id', 'weekday', 'start_time', 'end_time', 'available', 'note'], availRows);

  /* --------------------------------------------------- certifications -- */
  const FDACS = 'Florida Department of Agriculture and Consumer Services';
  const inDays = (n) => toDateString(new Date(now.getTime() + n * 86400000));
  const certRows = [];
  for (const [i, s] of Object.values(staff).entries()) {
    const lic = await db.prepare(`SELECT license_number, license_expires_on FROM users WHERE id = ?`).get(s.id);
    certRows.push([s.id, s.armed ? 'Class G Statewide Firearm Licence' : 'Class D Security Licence', lic.license_number,
      FDACS, inDays(-400 - i * 20), lic.license_expires_on, original.admin, null]);
    if (i % 2 === 0) {
      const cpr = s.code === '1017' ? -5 : s.code === '1016' ? 19 : 120 + i * 11;
      certRows.push([s.id, 'CPR / First Aid', `AHA-${30000 + i * 131}`, 'American Heart Association', inDays(cpr - 730), inDays(cpr),
        original.admin, s.code === '1017' ? 'Lapsed - booked on the next class.' : null]);
    }
    if (s.armed) {
      certRows.push([s.id, 'Firearms Requalification', null, 'USA Security range', inDays(-60 - i), inDays(305 - i), supervisorNorth, 'Qualified at 96%.']);
    }
    if (['1011', '1013', '1015', '1033'].includes(s.code)) {
      certRows.push([s.id, 'Healthcare Security (IAHSS Basic)', `IAHSS-${7700 + i}`, 'IAHSS', inDays(-300), inDays(430 - i * 9), supervisorSouth, null]);
    }
  }
  await batchInsert('certifications',
    ['user_id', 'type', 'number', 'issuing_authority', 'issued_on', 'expires_on', 'verified_by', 'notes'], certRows);

  /* -------------------------------------------------------- incidents -- */
  const next = Number((await db.prepare(`SELECT COUNT(*) AS n FROM incidents`).get()).n) + 1;
  for (const [i, inc] of INCIDENTS.entries()) {
    const who = staff[inc.code];
    const post = posts[inc.post];
    await db.prepare(
      `INSERT INTO incidents
       (ref_number, user_id, site_id, post_id, officer_name, callback_number, category, severity,
        occurred_at, location_text, what_happened, resolution, people_notified, police_notified,
        police_report_number, cost_recovery_cents, status, reviewed_by, reviewed_at, review_notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      `USC-${year}-${String(next + i).padStart(4, '0')}`, who.id, post.siteId, post.id, who.name,
      (await db.prepare(`SELECT phone FROM users WHERE id = ?`).get(who.id)).phone,
      inc.category, inc.severity, toSql(at(inc.days, inc.hour, (i * 13) % 60)), inc.at, inc.what,
      inc.resolution || null, inc.notified || null, Boolean(inc.police), inc.policeRef || null, inc.cost ?? null,
      inc.status,
      inc.status === 'closed' ? supervisorFor(who.siteKey) : null,
      inc.status === 'closed' ? toSql(at(inc.days + 1, 10)) : null,
      inc.status === 'closed' ? 'Report complete and accurate. Shared with the client contact.' : null
    );
  }

  /* ------------------------------------------------------------ tours -- */
  const hvTour = await buildTour(siteIds.harborview, 'Harborview Garage & Exterior Round',
    'Hourly round of the garage stairwells, ambulance bay and the exterior of the ED.', 30, [
      { name: 'Ambulance Bay', tag: 'USC-NFC-HV-401', lat: posts.hvEd.latitude, lng: posts.hvEd.longitude,
        tasks: ['Ambulance lane clear', 'ED doors latching'] },
      { name: 'Garage Level 2 Stairwell', tag: 'USC-NFC-HV-402', tasks: ['Stairwell clear', 'Emergency phone tested'] },
      { name: 'Garage Level 4 Stairwell', tag: 'USC-NFC-HV-403', tasks: ['Stairwell clear', 'Lighting operational'] },
      { name: 'Garage Roof Level', tag: 'USC-NFC-HV-404', tasks: ['No loitering', 'Gate to helipad locked'] },
      { name: 'Loading Dock', tag: 'USC-NFC-HV-405', required: false, tasks: ['Dock doors down'] },
    ]);
  const pdTour = await buildTour(siteIds.pensacola, 'Pensacola Yard Perimeter',
    'Fence line, trailer drop yard and the high-value cage exterior.', 40, [
      { name: 'Gatehouse', tag: 'USC-NFC-PD-501', lat: posts.pdGate.latitude, lng: posts.pdGate.longitude,
        tasks: ['Gate log current', 'Barrier arm operational'] },
      { name: 'Trailer Drop Yard - North', tag: 'USC-NFC-PD-502', tasks: ['Seals intact', 'No unhooked trailers unaccounted for'] },
      { name: 'East Fence Line', tag: 'USC-NFC-PD-503', tasks: ['No breaches', 'Lighting operational'] },
      { name: 'High-Value Cage Exterior', tag: 'USC-NFC-PD-504', tasks: ['Cage locked', 'Camera light on'] },
      { name: 'Fuel Island', tag: 'USC-NFC-PD-505', tasks: ['Pumps locked', 'Spill kit present'] },
    ]);
  const cpTour = await buildTour(siteIds.capital, 'Capital Plaza After-Hours Sweep',
    'Every floor’s lift lobby and stair doors after the building closes.', 45, [
      { name: 'Monroe St Doors', tag: 'USC-NFC-CP-601', lat: posts.cpLobby.latitude, lng: posts.cpLobby.longitude,
        tasks: ['Doors locked at 19:00'] },
      { name: 'Floor 8 Lift Lobby', tag: 'USC-NFC-CP-602', tasks: ['Stair doors latched'] },
      { name: 'Floor 15 Agency Suite', tag: 'USC-NFC-CP-603', tasks: ['Suite doors locked', 'Badge reader green'] },
      { name: 'Roof Plant Room', tag: 'USC-NFC-CP-604', required: false, tasks: ['Door secured'] },
    ]);

  const runRows = async (tourId, officerCode, hour, minutes) => {
    const checkpoints = await db.prepare(`SELECT id, required FROM checkpoints WHERE tour_id = ? ORDER BY sequence`).all(tourId);
    const post = posts[{ harborview: 'hvGarage', pensacola: 'pdGate', capital: 'cpGarage' }[staff[officerCode].siteKey]] || null;
    let runs = 0;
    for (let day = 14; day >= 1; day--) {
      if ((day * 5) % 13 === 0) continue;
      const started = at(-day, hour, (day * 11) % 50);
      const abandoned = day === 6;
      const runId = Number((await db.prepare(
        `INSERT INTO tour_runs (tour_id, user_id, started_at, completed_at, status) VALUES (?,?,?,?,?)`
      ).run(tourId, staff[officerCode].id, toSql(started),
        abandoned ? null : toSql(new Date(started.getTime() + minutes * MINUTE)), abandoned ? 'abandoned' : 'completed')).lastInsertRowid);
      runs += 1;
      const gap = Math.floor((minutes * MINUTE) / checkpoints.length);
      for (const [i, cp] of checkpoints.entries()) {
        if (abandoned && i >= 2) {
          await db.prepare(`INSERT INTO tour_run_checkpoints (tour_run_id, checkpoint_id, status) VALUES (?,?,'pending')`).run(runId, cp.id);
          continue;
        }
        const skipped = !cp.required && day % 4 === 0;
        const [lat, lng] = post ? positionAt(post, i * 7, day) : [null, null];
        await db.prepare(
          `INSERT INTO tour_run_checkpoints (tour_run_id, checkpoint_id, status, scanned_at, method, latitude, longitude, skip_reason)
           VALUES (?,?,?,?,?,?,?,?)`
        ).run(runId, cp.id, skipped ? 'skipped' : 'done', toSql(new Date(started.getTime() + gap * (i + 1))),
          skipped ? null : i % 2 ? 'qr' : 'nfc', skipped ? null : lat, skipped ? null : lng,
          skipped ? 'Area closed for maintenance by the client.' : null);
      }
      await db.exec(`
        INSERT INTO tour_run_tasks (tour_run_checkpoint_id, checkpoint_task_id, status, completed_at)
        SELECT trc.id, ct.id, 'done', trc.scanned_at
        FROM tour_run_checkpoints trc JOIN checkpoint_tasks ct ON ct.checkpoint_id = trc.checkpoint_id
        WHERE trc.tour_run_id = ${runId} AND trc.status = 'done'`);
    }
    return runs;
  };
  const tourRuns = (await runRows(hvTour, '1014', 20, 30)) + (await runRows(pdTour, '1027', 21, 40)) + (await runRows(cpTour, '1020', 23, 45));

  /* ------------------------------------------------- supervisor visits -- */
  // Each visit's own note is about the officer and stays with us; the client
  // note is what the property's contacts read in the portal.
  const VISITS = [
    ['1011', 'hvEd', -1, 10, 5, 'ED doors well controlled during a busy morning. Visitor band compliance spot-checked: 20 of 20.',
      'Supervisor visit to the Emergency Department entrance. Visitor bands spot-checked: all in order.'],
    ['1013', 'hvEd', -4, 2, 4, 'Handled a Code Grey well the night before. Reminded to complete the incident report before end of shift, not after.',
      'Overnight supervisor visit. Post in good order.'],
    ['1014', 'hvGarage', -3, 21, 4, 'Garage round driven as required. Two stairwell lights out on level 5 - reported to facilities.',
      'Garage patrol checked. Two stairwell lights out on level 5 have been reported to your facilities team.'],
    ['1016', 'bmDock', -16, 18, 5, 'Excellent knowledge of the dock and the members. Bilge alarm response was textbook.',
      'Supervisor visit to the dock post. No concerns.'],
    ['1018', 'cpLobby', -2, 8, 5, 'Turnstile queue managed calmly at 08:30 peak. Pre-registration list current.',
      'Lobby visited during the morning peak. Visitor pre-registration working as agreed.'],
    ['1020', 'cpGarage', -6, 23, 5, 'Weapon inspection logged. P3 closed and walked. No concerns.',
      'Late-evening garage visit. Level P3 closed and checked.'],
    ['1021', 'rpLab', -7, 11, 4, 'BSL-2 tailgating log up to date. Asked her to escalate the freezer panel fault again.',
      'Lab entrance visited. The freezer panel fault has been raised with your facilities team again.'],
    ['1023', 'rpPatrol', -9, 1, 3, 'Patrol vehicle log had two gaps of over an hour. Discussed - radio dead spot on the far lot. Raised with the client.',
      'Overnight patrol checked. There is a radio dead spot on the far lot; we are proposing a fix.'],
    ['1024', 'soFloor', -3, 14, 4, 'Good visibility in the food court. Uniform jacket missing its patch - replacement ordered.',
      'Supervisor visit to the mall floor. Good visibility in the food court.', ['uniform']],
    ['1026', 'pdGate', -2, 7, 5, 'Seal verification on three trucks observed. Thorough and polite with drivers.',
      'Gate visited at shift change. Seal verification observed on three trucks.'],
    ['1028', 'pdWarehouse', -5, 22, 5, 'Two-person rule on the cage enforced without exception. Aisle tag scans complete.',
      'Warehouse visited. Two-person rule on the high-value cage followed.'],
  ];
  for (const [code, postKey, days, hour, rating, notes, clientNote, fails = []] of VISITS) {
    const post = posts[postKey];
    await db.prepare(
      `INSERT INTO supervisor_visits
       (supervisor_id, officer_id, site_id, post_id, visited_at, uniform_ok, post_orders_reviewed, equipment_ok,
        site_secure, rating, notes, client_note, latitude, longitude)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(supervisorFor(post.siteKey), staff[code].id, post.siteId, post.id, toSql(at(days, hour, 15)),
      rating >= 4 && !fails.includes('uniform'), true, rating >= 4, true, rating, notes, clientNote, post.latitude, post.longitude);
  }

  /* ------------------------------------------------------- broadcasts -- */
  const officerIds = Object.values(staff).filter((s) => s.role === 'officer').map((s) => s.id);
  for (const [site, title, body, priority, daysAgo] of [
    ['harborview', 'Harborview: new visitor band colours from Monday',
      'Visitor bands change from yellow to green on Monday. Yellow bands are void from 00:00. Maternity visitors keep the pink L&D band. Spare rolls are in the ED desk drawer.', 'important', 2],
    ['pensacola', 'Pensacola: seal verification is now two-person on outbound',
      'After last month’s shortfall, every outbound trailer seal is read by the gate officer and confirmed by the shipping clerk. Both initial the log. No exceptions for the 05:00 wave.', 'urgent', 5],
    ['capital', 'Capital Plaza: legislative committee weeks',
      'Committee weeks bring heavy visitor traffic to floors 14-16. Two officers on the lobby desk 08:00-16:00 on those days. Check the schedule for the dates.', 'normal', 1],
  ]) {
    const id = Number((await db.prepare(
      `INSERT INTO broadcasts (title, body, priority, requires_ack, audience_site_id, published_at, created_by)
       VALUES (?,?,?,?,?,?,?)`
    ).run(title, body, priority, priority !== 'normal', siteIds[site], toSql(at(-daysAgo, 8, 30)), original.admin)).lastInsertRowid);
    const audience = Object.values(staff).filter((s) => s.siteKey === site && s.role === 'officer');
    for (const [i, s] of audience.entries()) {
      if (i % 3 === 2) continue;
      await db.prepare(`INSERT INTO broadcast_receipts (broadcast_id, user_id, read_at, acknowledged_at) VALUES (?,?,?,?)`)
        .run(id, s.id, toSql(at(-daysAgo, 12, i)), priority !== 'normal' && i % 2 === 0 ? toSql(at(-daysAgo, 12, i + 5)) : null);
    }
  }

  // Everyone should see the company-wide notice board as well; mark the older
  // ones read for the new staff so their inbox is not a wall of unread.
  const companyWide = await db.prepare(
    `SELECT id FROM broadcasts WHERE audience_site_id IS NULL AND published_at < ?`
  ).all(toSql(at(-3, 0)));
  const receiptRows = [];
  for (const b of companyWide) {
    for (const uid of officerIds) receiptRows.push([b.id, uid, toSql(at(-2, 9)), null]);
  }
  await batchInsert('broadcast_receipts', ['broadcast_id', 'user_id', 'read_at', 'acknowledged_at'], receiptRows);

  /* --------------------------------------------------- client portal -- */
  const clientLogins = [
    ['carla.mendez@harborviewhealth.org', 'Carla Mendez', 'Harborview Health System', 'harborview-portal-04', ['harborview']],
    ['rpike@emeraldcoastlogistics.com', 'Russell Pike', 'Emerald Coast Logistics', 'pensacola-portal-05', ['pensacola']],
    ['dfaulkner@capitalplazart.com', 'Denise Faulkner', 'Capital Plaza Realty Trust', 'capital-portal-06', ['capital']],
  ];
  for (const [email, name, company, password, sites] of clientLogins) {
    const { hash, salt } = hashPassword(password);
    const id = Number((await db.prepare(
      `INSERT INTO client_users (email, name, company, password_hash, password_salt, created_by) VALUES (?,?,?,?,?,?)`
    ).run(email, name, company, hash, salt, original.admin)).lastInsertRowid);
    for (const s of sites) await db.prepare(`INSERT INTO client_sites (client_user_id, site_id) VALUES (?,?)`).run(id, siteIds[s]);
  }

  /* ---------------------------------------------------------- invoices -- */
  const dayStart = (offset) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    return d;
  };
  let invoiceCount = 0;
  for (const spec of [
    { site: 'harborview', from: -14, to: -8, status: 'paid', due: -2 },
    { site: 'harborview', from: -7, to: -1, status: 'sent', due: 23 },
    { site: 'capital', from: -7, to: -1, status: 'sent', due: 23 },
    { site: 'pensacola', from: -14, to: -8, status: 'sent', due: -3 },
    { site: 'pensacola', from: -7, to: -1, status: 'draft', due: 30 },
  ]) {
    const start = dayStart(spec.from);
    const { lines } = await buildLines({ siteId: siteIds[spec.site], start, end: dayStart(spec.to + 1) });
    if (!lines.length) continue;
    const totals = invoiceTotals(lines, 0);
    const id = Number((await db.prepare(
      `INSERT INTO invoices (number, site_id, period_start, period_end, status, subtotal_cents, tax_cents,
                             total_cents, cost_cents, due_on, issued_at, paid_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(await nextNumber(now.getFullYear()), siteIds[spec.site], toDateString(start), toDateString(dayStart(spec.to)),
      spec.status, totals.subtotalCents, totals.taxCents, totals.totalCents, totals.costCents,
      toDateString(dayStart(spec.due)), spec.status === 'draft' ? null : toSql(dayStart(spec.to + 1)),
      spec.status === 'paid' ? toSql(dayStart(spec.due)) : null, original.admin)).lastInsertRowid);
    for (const line of lines) {
      await db.prepare(
        `INSERT INTO invoice_lines (invoice_id, post_id, description, minutes, rate_cents, amount_cents, cost_cents, sequence)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(id, line.post_id, line.description, line.minutes, line.rate_cents, line.amount_cents, line.cost_cents, line.sequence);
    }
    invoiceCount += 1;
  }

  return {
    sites: SITES.length,
    posts: Object.keys(posts).length,
    staff: Object.values(staff).map((s) => ({ ...s, pin: pins[s.code] })),
    shifts: plan.length + specialRows.length,
    worked: worked.length,
    live: liveSummary,
    pings: pingRows.length,
    walkOffs,
    noShows: noShowCount,
    tourRuns,
    invoices: invoiceCount,
    clientLogins: clientLogins.map(([email, , , password, sites]) => ({ email, password, site: SITES.find((s) => s.key === sites[0]).name })),
  };
}
