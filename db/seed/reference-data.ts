// Fictional customers, personnel and naming pools used only to generate realistic-looking demo data.
// None of these represent real companies or people.

export const CUSTOMERS = [
  'Kavir Steel Industries',
  'Alborz Copper Complex',
  'South Zagros Petrochemical',
  'Persepolis Cement Group',
  'Zagros Aluminum Smelting Co.',
  'National Textile Manufacturing',
  'Kavir Desert Mining Co.',
  'Central Iran Water & Power Authority',
  'Sepehr Food Industries',
  'Elburz Glass Manufacturing',
  'Pars Automotive Parts Co.',
  'Kerman Regional Electricity Distribution',
  'Yazd Textile & Spinning Co.',
  'Bandar Petrochemical Terminal',
  'Tabriz Machine Tools Co.',
  'Semnan Industrial Estate Authority',
];

export const FIRST_NAMES = [
  'Ali', 'Reza', 'Mohammad', 'Hassan', 'Hossein', 'Amir', 'Saeed', 'Kaveh', 'Farhad', 'Babak',
  'Mehdi', 'Arash', 'Kamran', 'Peyman', 'Shahin', 'Sara', 'Maryam', 'Niloofar', 'Fatemeh', 'Zahra',
  'Leila', 'Parisa', 'Yasmin', 'Elham', 'Roya',
];

export const LAST_NAMES = [
  'Ahmadi', 'Hosseini', 'Karimi', 'Moradi', 'Jafari', 'Rostami', 'Ghasemi', 'Sadeghi', 'Rahimi',
  'Bagheri', 'Kazemi', 'Norouzi', 'Fallahi', 'Amini', 'Sharifi', 'Tehrani', 'Mousavi', 'Ebrahimi',
  'Salehi', 'Yazdani',
];

export const SUBSTATION_NAME_SUFFIXES = ['Main Substation', 'Distribution Substation', 'Intake Substation', 'Plant Substation'];

export const VOLTAGE_LEVELS = ['20kV', '33kV', '63kV', '66kV', '132kV/33kV', '132kV/20kV', '230kV/63kV', '400kV/132kV'];

export const PANEL_TYPES = ['FEEDER', 'TRANSFORMER_FEEDER', 'INCOMER', 'BUS_COUPLER', 'CAPACITOR_BANK', 'MOTOR'] as const;
export type PanelType = (typeof PANEL_TYPES)[number];

export const PANEL_TYPE_WEIGHTS: [PanelType, number][] = [
  ['FEEDER', 45],
  ['TRANSFORMER_FEEDER', 20],
  ['INCOMER', 15],
  ['BUS_COUPLER', 10],
  ['MOTOR', 6],
  ['CAPACITOR_BANK', 4],
];

export const SWITCHGEAR_TYPES = ['AIS', 'GIS', 'RMU'];
