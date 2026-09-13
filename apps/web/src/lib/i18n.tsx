'use client';

/**
 * Interface language.
 *
 * TRANSLATION POLICY, decided with the customer: everything a person reads is Persian — labels,
 * buttons, messages, explanations — but STANDARD PROTECTION AND PROTOCOL VOCABULARY STAYS IN
 * ENGLISH. A protection engineer knows the device as "IEC 60870-5-104", the function as
 * "Overcurrent 50/51" and the address table as a "point map"; translating those would make the
 * screen harder to use for the very people who use it most, not easier. So protocol names, ANSI
 * codes, manufacturer and model names, and status enum values coming from the database are left
 * exactly as they are.
 *
 * Persian is right-to-left, but a run of Latin text inside a Persian sentence must still read
 * left-to-right or its punctuation ends up on the wrong side — an IP address renders as "50.10.168.192"
 * and a required-field marker appears as "* Protocol" instead of "Protocol *". Wrap those runs in
 * <Ltr> (below) rather than leaving them to the paragraph's direction.
 */

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type Lang = 'en' | 'fa';

const dict = {
  en: {
    appName: 'Simorgh Grid',
    tagline: 'Electrical Projects & Protection Command Center — Electro Kavir',
    nav_overview: 'Overview',
    nav_map: 'Global Map',
    nav_projects: 'Projects',
    nav_live: 'Live Operations',
    nav_relays: 'Relays',
    nav_comms: 'Communications',
    nav_provisioning: 'Add Project / Relay',
    nav_faults: 'Faults',
    nav_alarms: 'Alarms',
    nav_ai: 'AI Intelligence',
    nav_workorders: 'Work Orders',
    nav_reports: 'Reports',
    nav_executive: 'Executive',
    nav_admin: 'Administration',
    demo_badge: 'DEMO DATA — synthetic, not live field data',
    total_projects: 'Total Projects',
    active_projects: 'Active Projects',
    running: 'Running',
    commissioning: 'Commissioning',
    engineering: 'Engineering',
    critical: 'Critical',
    unresolved_faults: 'Unresolved Faults',
    active_alarms: 'Active Alarms',
    total_relays: 'Total Relays',
    online_relays: 'Online Relays',
    offline_relays: 'Offline Relays',
    relays_with_alarms: 'Relays w/ Alarms',
    recent_trips: 'Recent Trips',
    cities_covered: 'Cities Covered',
    healthy_projects: 'Healthy Projects',
    needs_engineering: 'Needs Engineering',
    needs_field_service: 'Needs Field Service',
    comm_problems: 'Comm. Problems',
    sign_in: 'Sign in',
    sign_out: 'Sign out',
    signing_in: 'Signing in…',
    email: 'Email',
    password: 'Password',
    show: 'Show',
    hide: 'Hide',
    authorised_only: 'Electro Kavir — authorised personnel only',
    loading: 'Loading…',
    retry: 'Retry',
    back: 'Back',
    save: 'Save',
    cancel: 'Cancel',
    done: 'Done',
    close: 'Close',
    search: 'Search',
    all: 'All',
    updating: 'updating',
    none_match: 'No records match these filters.',
    could_not_load: 'Could not load this data',
    not_all_clear: 'This is a display problem, not a field reading. Do not treat this screen as an all-clear — check that the API is running and that NEXT_PUBLIC_API_URL points at it.',
    overview_sub: 'National command-center snapshot, refreshed automatically every 15s',
    fault_trend_30: 'Fault Trend — Last 30 Days',
    relay_fleet: 'Relay Fleet',
    stale_figures: 'The figures below are the last successful reading and are no longer updating.',
    map_title: 'Map Command Centre',
    projects_word: 'projects',
    cities_word: 'cities',
    countries_word: 'countries',
    set_location: 'Set location',
    click_map_here: 'Click the map where the panel is',
    no_coords_needed: 'No coordinates to type. You pick the project after dropping the pin.',
    pick_other_spot: 'Pick a different spot',
    which_project_here: 'Which project is here?',
    save_location: 'Save location',
    place_label: 'Place label',
    country: 'Country',
    choose: '— choose —',
    marker_legend: 'Number in circle = project count',
    cluster_legend: 'Merged circle: click to zoom in',
    map_word: 'Map',
    projects_sub: 'Every electrical project, drillable down to individual relays.',
    search_projects: 'Search by name or code…',
    all_statuses: 'All statuses',
    code: 'Code',
    project: 'Project',
    location: 'Location',
    status: 'Status',
    progress: 'Progress',
    health: 'Health',
    flags: 'Flags',
    no_projects_match: 'No projects match these filters.',
    relays_sub: 'Vendor-neutral view across every connected relay. Sorted by health score.',
    search_relays: 'Search relay code or model…',
    all_manufacturers: 'All manufacturers',
    all_health: 'All health states',
    relay: 'Relay',
    manufacturer_model: 'Manufacturer / Model',
    project_panel: 'Project / Panel',
    comm: 'Comm',
    breaker: 'Breaker',
    trips: 'Trips',
    alarms_word: 'Alarms',
    no_relays_match: 'No relays match these filters.',
    protection_functions: 'Protection Functions',
    configured: 'configured',
    disabled_count: 'disabled',
    ansi: 'ANSI',
    function: 'Function',
    pickup: 'Pickup',
    time_delay: 'Time delay',
    state: 'State',
    enabled: 'enabled',
    disabled: 'DISABLED',
    no_prot_fns: 'No protection functions recorded for this relay.',
    recent_events_soe: 'Recent Events (SOE)',
    communication: 'Communication',
    protection: 'Protection',
    setting_group: 'Setting Group',
    trip_count: 'Trip Count',
    alarm_count: 'Alarm Count',
    last_communication: 'Last Communication',
    faults_sub: 'Protection operations captured across the fleet, with acknowledgement and resolution workflow.',
    all_severities: 'All severities',
    all_resolutions: 'All resolution states',
    fault: 'Fault',
    time: 'Time',
    project_relay: 'Project / Relay',
    type: 'Type',
    severity: 'Severity',
    trip: 'Trip',
    ack: 'Ack.',
    resolution: 'Resolution',
    no_faults_match: 'No faults match these filters.',
    analyze: 'Analyze',
    analyzing: 'Analyzing…',
    no_analysis_yet: 'No analysis yet. Click Analyze to generate a root-cause assessment (advisory only — never auto-applied).',
    analysis_failed: 'The analysis request failed.',
    alarms_sub: 'Correlated, prioritized alarms across the fleet — grouped to avoid alarm flooding.',
    acknowledge: 'Acknowledge',
    acknowledging: 'Acknowledging…',
    no_alarms_filter: 'No alarms in this filter.',
    ack_failed: 'Could not acknowledge this alarm.',
    correlated: 'correlated',
    wo_sub: 'FAULT → ANALYSIS → WORK ORDER → ASSIGNED → FIELD INSPECTION → REPAIR → TEST → VERIFIED → CLOSED',
    wo: 'WO',
    equipment: 'Equipment',
    priority: 'Priority',
    assigned: 'Assigned',
    due: 'Due',
    no_wo_filter: 'No work orders in this filter.',
    work_orders_word: 'work orders',
    live_sub: 'Live event stream from the fleet.',
    waiting_events: 'Waiting for events…',
    connected: 'Connected',
    disconnected: 'Disconnected',
    history_failed: 'Could not load event history',
    empty_not_quiet: 'an empty feed here does not mean the network is quiet.',
    exec_sub: 'Management-level view — no relay protocol detail required.',
    monthly_fault_trend: 'Monthly Fault Trend',
    projects_delayed: 'Delayed',
    projects_at_risk: 'At Risk',
    critical_faults: 'Critical Faults',
    open_work_orders: 'Open Work Orders',
    relay_fleet_health: 'Relay Fleet Health',
    exec_summary_failed: 'Could not load the executive summary.',
    prov_sub: 'Create a project and register a real relay. Province and city only — no site address is ever recorded.',
    step_project: 'Project',
    step_substation: 'Substation',
    step_switchgear: 'Switchgear',
    step_panel: 'Panel',
    step_relay: 'Relay',
    step_connection: 'Connection',
    project_code: 'Project code',
    name: 'Name',
    province: 'Province',
    city_county: 'City / County',
    region_state: 'Region / State',
    city: 'City',
    voltage_level: 'Voltage level',
    add: '+ add',
    select_region_first: 'Select a region first',
    name_latin_ph: 'Name, e.g. Berlin',
    name_fa_ph: 'Persian name (optional)',
    city_name_ph: 'City name',
    add_region: 'Add region',
    add_city: 'Add city',
    saving: 'Saving…',
    loc_note: 'Location is recorded as province and city only. There is no field for an address or coordinates.',
    how_gateway_reaches: 'How the gateway reaches this relay',
    protocol: 'Protocol',
    show_all_30: 'Show all 30',
    show_recommended: 'Show recommended only',
    five_over_ethernet: 'These five reach a relay over Ethernet with nothing else to install. The other 25 cover serial links, legacy fleets and supporting channels.',
    path_id: 'Path id',
    role: 'Role',
    relay_ip: 'Relay IP address',
    port: 'Port',
    poll_interval: 'Poll interval (ms)',
    supervision_timeout: 'Supervision timeout (s)',
    point_map_profile: 'Point-map profile',
    point_map_why: 'this protocol carries numbers with no built-in meaning',
    point_map_caveat: 'Built-in profiles are typical values from vendor documentation, not a guarantee for your exact model and firmware. Verify the addresses against the relay manual before trusting the data.',
    test_connection: 'Test connection',
    testing: 'Testing…',
    test_hint: 'Checks whether the relay answers, before you save.',
    path_incomplete: 'Path configuration is incomplete',
    register_relay: 'Register relay',
    create_continue: 'Create and continue',
    working: 'Working…',
    view_projects: 'View projects',
    register_another: 'Register another',
    firmware: 'Firmware',
    serial_number: 'Serial number',
    model: 'Model',
    manufacturer: 'Manufacturer',
    relay_code: 'Relay code',
    comms_sub: 'How every relay is reached, and which links are healthy.',
    ai_sub: 'Advisory AI assistant — every conclusion is backed by the data shown alongside it.',
    ai_greeting: 'I\'m Simorgh Grid Copilot. Ask me about fault rates, relay health, at-risk projects, or what happened in a specific city — I\'ll always show the data behind my answer.',
    ask_placeholder: 'Ask about faults, relays, alarms, or project risk…',
    send: 'Send',
    sending: 'Sending…',
    thinking: 'Simorgh is thinking…',
    evidence: 'Evidence',
    admin_sub: 'Who did what, and when.',
    relay_registered: 'Relay registered',
    substation_plant: 'Substation / plant',
    protection_relay: 'Protection relay',
    admin_audit_sub: 'Immutable audit log — every security-relevant action across the platform.',
    welcome_init: 'Initializing Intelligent Grid Environment…',
    skip: 'Skip',
    continue_anyway: 'Continue anyway',
  },
  fa: {
    appName: 'سیمرغ گرید',
    tagline: 'مرکز فرماندهی پروژه‌های برقی و حفاظت الکترو کویر',
    nav_overview: 'نمای کلی',
    nav_map: 'نقشه جهانی',
    nav_projects: 'پروژه‌ها',
    nav_live: 'عملیات زنده',
    nav_relays: 'رله‌ها',
    nav_comms: 'ارتباطات',
    nav_provisioning: 'افزودن پروژه / رله',
    nav_faults: 'خطاها',
    nav_alarms: 'آلارم‌ها',
    nav_ai: 'هوش مصنوعی',
    nav_workorders: 'دستور کارها',
    nav_reports: 'گزارش‌ها',
    nav_executive: 'مدیریت ارشد',
    nav_admin: 'مدیریت سامانه',
    demo_badge: 'داده نمایشی — مصنوعی، غیر واقعی',
    total_projects: 'کل پروژه‌ها',
    active_projects: 'پروژه‌های فعال',
    running: 'بهره‌برداری',
    commissioning: 'راه‌اندازی',
    engineering: 'مهندسی',
    critical: 'بحرانی',
    unresolved_faults: 'خطاهای حل‌نشده',
    active_alarms: 'آلارم‌های فعال',
    total_relays: 'کل رله‌ها',
    online_relays: 'رله‌های آنلاین',
    offline_relays: 'رله‌های آفلاین',
    relays_with_alarms: 'رله با آلارم',
    recent_trips: 'تریپ‌های اخیر',
    cities_covered: 'شهرهای تحت پوشش',
    healthy_projects: 'پروژه‌های سالم',
    needs_engineering: 'نیازمند مهندسی',
    needs_field_service: 'نیازمند خدمات میدانی',
    comm_problems: 'مشکل ارتباطی',
    sign_in: 'ورود',
    sign_out: 'خروج',
    signing_in: 'در حال ورود…',
    email: 'ایمیل',
    password: 'رمز عبور',
    show: 'نمایش',
    hide: 'پنهان',
    authorised_only: 'الکترو کویر — ویژهٔ کارکنان مجاز',
    loading: 'در حال بارگذاری…',
    retry: 'تلاش دوباره',
    back: 'بازگشت',
    save: 'ذخیره',
    cancel: 'انصراف',
    done: 'پایان',
    close: 'بستن',
    search: 'جستجو',
    all: 'همه',
    updating: 'در حال به‌روزرسانی',
    none_match: 'موردی با این فیلترها پیدا نشد.',
    could_not_load: 'بارگذاری اطلاعات ممکن نشد',
    not_all_clear: 'این یک مشکل نمایش است، نه خواندهٔ میدانی. این صفحه را به معنی «همه‌چیز سالم» نگیرید — بررسی کنید که API بالا باشد و NEXT_PUBLIC_API_URL درست تنظیم شده باشد.',
    overview_sub: 'نمای لحظه‌ای مرکز فرماندهی، هر ۱۵ ثانیه به‌روز می‌شود',
    fault_trend_30: 'روند خطاها — ۳۰ روز گذشته',
    relay_fleet: 'ناوگان رله',
    stale_figures: 'ارقام زیر آخرین خواندهٔ موفق هستند و دیگر به‌روز نمی‌شوند.',
    map_title: 'مرکز فرماندهی نقشه',
    projects_word: 'پروژه',
    cities_word: 'شهر',
    countries_word: 'کشور',
    set_location: 'ثبت موقعیت',
    click_map_here: 'روی نقشه کلیک کنید تا محل تابلو مشخص شود',
    no_coords_needed: 'لازم نیست مختصات را تایپ کنید. بعد از کلیک، پروژه را انتخاب می‌کنید.',
    pick_other_spot: 'جای دیگری کلیک کنم',
    which_project_here: 'این محل مربوط به کدام پروژه است؟',
    save_location: 'ذخیرهٔ موقعیت',
    place_label: 'نام محل',
    country: 'کشور',
    choose: '— انتخاب —',
    marker_legend: 'عدد داخل دایره = تعداد پروژه',
    cluster_legend: 'دایرهٔ ادغام‌شده: برای بزرگ‌نمایی کلیک کنید',
    map_word: 'نقشه',
    projects_sub: 'همهٔ پروژه‌های برقی، تا سطح تک‌تک رله‌ها قابل بررسی.',
    search_projects: 'جستجو با نام یا کد…',
    all_statuses: 'همهٔ وضعیت‌ها',
    code: 'کد',
    project: 'پروژه',
    location: 'موقعیت',
    status: 'وضعیت',
    progress: 'پیشرفت',
    health: 'سلامت',
    flags: 'نشانه‌ها',
    no_projects_match: 'پروژه‌ای با این فیلترها پیدا نشد.',
    relays_sub: 'نمای مستقل از سازنده روی همهٔ رله‌های متصل، مرتب بر اساس امتیاز سلامت.',
    search_relays: 'جستجوی کد یا مدل رله…',
    all_manufacturers: 'همهٔ سازنده‌ها',
    all_health: 'همهٔ وضعیت‌های سلامت',
    relay: 'رله',
    manufacturer_model: 'سازنده / مدل',
    project_panel: 'پروژه / پنل',
    comm: 'ارتباط',
    breaker: 'بریکر',
    trips: 'تریپ‌ها',
    alarms_word: 'آلارم‌ها',
    no_relays_match: 'رله‌ای با این فیلترها پیدا نشد.',
    protection_functions: 'توابع حفاظتی',
    configured: 'تعریف‌شده',
    disabled_count: 'غیرفعال',
    ansi: 'ANSI',
    function: 'تابع',
    pickup: 'Pickup',
    time_delay: 'تأخیر زمانی',
    state: 'وضعیت',
    enabled: 'فعال',
    disabled: 'غیرفعال',
    no_prot_fns: 'تابع حفاظتی برای این رله ثبت نشده است.',
    recent_events_soe: 'رویدادهای اخیر (SOE)',
    communication: 'ارتباط',
    protection: 'حفاظت',
    setting_group: 'گروه تنظیمات',
    trip_count: 'تعداد تریپ',
    alarm_count: 'تعداد آلارم',
    last_communication: 'آخرین ارتباط',
    faults_sub: 'عملکردهای حفاظتی ثبت‌شده در کل ناوگان، همراه با گردش کار تأیید و رفع.',
    all_severities: 'همهٔ شدت‌ها',
    all_resolutions: 'همهٔ وضعیت‌های رفع',
    fault: 'خطا',
    time: 'زمان',
    project_relay: 'پروژه / رله',
    type: 'نوع',
    severity: 'شدت',
    trip: 'تریپ',
    ack: 'تأیید',
    resolution: 'رفع',
    no_faults_match: 'خطایی با این فیلترها پیدا نشد.',
    analyze: 'تحلیل',
    analyzing: 'در حال تحلیل…',
    no_analysis_yet: 'هنوز تحلیلی انجام نشده. برای ارزیابی ریشه‌ای روی «تحلیل» بزنید (فقط مشورتی — هرگز خودکار اعمال نمی‌شود).',
    analysis_failed: 'درخواست تحلیل انجام نشد.',
    alarms_sub: 'آلارم‌های همبسته و اولویت‌بندی‌شده — گروه‌بندی شده تا سیل آلارم ایجاد نشود.',
    acknowledge: 'تأیید',
    acknowledging: 'در حال تأیید…',
    no_alarms_filter: 'آلارمی در این فیلتر نیست.',
    ack_failed: 'تأیید این آلارم ممکن نشد.',
    correlated: 'همبسته',
    wo_sub: 'FAULT → ANALYSIS → WORK ORDER → ASSIGNED → FIELD INSPECTION → REPAIR → TEST → VERIFIED → CLOSED',
    wo: 'شماره',
    equipment: 'تجهیز',
    priority: 'اولویت',
    assigned: 'مسئول',
    due: 'مهلت',
    no_wo_filter: 'دستور کاری در این فیلتر نیست.',
    work_orders_word: 'دستور کار',
    live_sub: 'جریان زندهٔ رویدادها از ناوگان.',
    waiting_events: 'در انتظار رویداد…',
    connected: 'متصل',
    disconnected: 'قطع',
    history_failed: 'بارگذاری تاریخچهٔ رویدادها ممکن نشد',
    empty_not_quiet: 'خالی بودن این فهرست به معنی آرام بودن شبکه نیست.',
    exec_sub: 'نمای مدیریتی — بدون نیاز به جزئیات پروتکل رله.',
    monthly_fault_trend: 'روند ماهانهٔ خطاها',
    projects_delayed: 'تأخیردار',
    projects_at_risk: 'در معرض ریسک',
    critical_faults: 'خطاهای بحرانی',
    open_work_orders: 'دستور کارهای باز',
    relay_fleet_health: 'سلامت ناوگان رله',
    exec_summary_failed: 'بارگذاری خلاصهٔ مدیریتی ممکن نشد.',
    prov_sub: 'ایجاد پروژه و ثبت یک رلهٔ واقعی. فقط استان و شهرستان — هیچ آدرس دقیقی ثبت نمی‌شود.',
    step_project: 'پروژه',
    step_substation: 'پست',
    step_switchgear: 'تابلو',
    step_panel: 'پنل',
    step_relay: 'رله',
    step_connection: 'ارتباط',
    project_code: 'کد پروژه',
    name: 'نام',
    province: 'استان',
    city_county: 'شهرستان',
    region_state: 'استان / ایالت',
    city: 'شهر',
    voltage_level: 'سطح ولتاژ',
    add: '+ افزودن',
    select_region_first: 'ابتدا استان را انتخاب کنید',
    name_latin_ph: 'نام لاتین، مثلاً Berlin',
    name_fa_ph: 'نام فارسی (اختیاری)',
    city_name_ph: 'نام لاتین شهر',
    add_region: 'افزودن استان/ایالت',
    add_city: 'افزودن شهر',
    saving: 'در حال ذخیره…',
    loc_note: 'موقعیت فقط در حد استان و شهرستان ثبت می‌شود. فیلدی برای آدرس یا مختصات وجود ندارد.',
    how_gateway_reaches: 'گیت‌وی چطور به این رله می‌رسد',
    protocol: 'Protocol',
    show_all_30: 'نمایش هر ۳۰ پروتکل',
    show_recommended: 'فقط پیشنهادی‌ها',
    five_over_ethernet: 'این پنج مورد بدون نصب چیز دیگری از طریق اترنت به رله می‌رسند. ۲۵ مورد دیگر مربوط به لینک سریال، تجهیزات قدیمی و کانال‌های پشتیبان است.',
    path_id: 'شناسهٔ مسیر',
    role: 'نقش',
    relay_ip: 'آدرس IP رله',
    port: 'پورت',
    poll_interval: 'فاصلهٔ نظرسنجی (ms)',
    supervision_timeout: 'مهلت نظارت (ثانیه)',
    point_map_profile: 'پروفایل Point map',
    point_map_why: 'این پروتکل عددهایی را حمل می‌کند که معنی ذاتی ندارند',
    point_map_caveat: 'پروفایل‌های آماده مقادیر معمول از مستندات سازنده هستند، نه تضمینی برای مدل و فرم‌ور دقیق شما. قبل از اعتماد به داده، آدرس‌ها را با دفترچهٔ رله بررسی کنید.',
    test_connection: 'تست اتصال',
    testing: 'در حال تست…',
    test_hint: 'قبل از ذخیره بررسی می‌کند که رله پاسخ می‌دهد یا نه.',
    path_incomplete: 'پیکربندی مسیر ناقص است',
    register_relay: 'ثبت رله',
    create_continue: 'ایجاد و ادامه',
    working: 'در حال انجام…',
    view_projects: 'مشاهدهٔ پروژه‌ها',
    register_another: 'ثبت مورد بعدی',
    firmware: 'فرم‌ور',
    serial_number: 'شمارهٔ سریال',
    model: 'مدل',
    manufacturer: 'سازنده',
    relay_code: 'کد رله',
    comms_sub: 'هر رله از چه راهی خوانده می‌شود و کدام لینک‌ها سالم هستند.',
    ai_sub: 'دستیار مشورتی — هر نتیجه با داده‌ای که کنارش نشان داده می‌شود پشتیبانی می‌شود.',
    ai_greeting: 'من دستیار سیمرغ گرید هستم. دربارهٔ نرخ خطا، سلامت رله، پروژه‌های در ریسک یا اتفاقات یک شهر بپرسید — همیشه داده‌ای که پاسخ بر آن استوار است را نشان می‌دهم.',
    ask_placeholder: 'دربارهٔ خطاها، رله‌ها، آلارم‌ها یا ریسک پروژه بپرسید…',
    send: 'ارسال',
    sending: 'در حال ارسال…',
    thinking: 'سیمرغ در حال بررسی…',
    evidence: 'مستندات',
    admin_sub: 'چه کسی، چه کاری، و چه زمانی.',
    relay_registered: 'رله ثبت شد',
    substation_plant: 'پست / نیروگاه',
    protection_relay: 'رلهٔ حفاظتی',
    admin_audit_sub: 'دفتر ثبت تغییرناپذیر — هر اقدام مرتبط با امنیت در کل سامانه.',
    welcome_init: 'در حال آماده‌سازی محیط هوشمند شبکه…',
    skip: 'رد کردن',
    continue_anyway: 'ادامه به هر حال',
  },
} as const;

type DictKey = keyof typeof dict.en;

interface I18nContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: DictKey) => string;
  dir: 'ltr' | 'rtl';
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = useState<Lang>('en');

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? (window.localStorage.getItem('simorgh_lang') as Lang | null) : null;
    if (stored) setLang(stored);
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem('simorgh_lang', lang);
    if (typeof document !== 'undefined') {
      document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
      document.documentElement.lang = lang;
    }
  }, [lang]);

  const value = useMemo<I18nContextValue>(
    () => ({
      lang,
      setLang,
      dir: lang === 'fa' ? 'rtl' : 'ltr',
      t: (key: DictKey) => dict[lang][key] ?? dict.en[key] ?? key,
    }),
    [lang]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}

/**
 * A run of Latin text inside Persian copy.
 *
 * Without an explicit direction, the browser applies the paragraph's RTL order to the whole run and
 * anything non-alphabetic — a dot, a colon, an asterisk, a slash — moves to the wrong end. That is
 * how "192.168.10.50:2404" came out reversed and "Protocol *" rendered as "* Protocol". Everything
 * technical goes through this: IP addresses, ports, protocol names, ANSI codes, model numbers.
 */
export function Ltr({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span dir="ltr" style={{ unicodeBidi: 'isolate' }} className={className}>
      {children}
    </span>
  );
}

/**
 * Pick the Persian or English name for a record that carries both.
 *
 * Cities and provinces are stored with `name_en` and `name_fa`, but every table rendered the English
 * column regardless of language, so a Persian screen listed Karaj, Mashhad and Isfahan in Latin
 * script beside Persian headers. Falls back to whichever name exists, so a user-created location
 * entered with only a Latin name still shows something.
 */
export function useLocalName() {
  const { lang } = useI18n();
  return (en?: string | null, fa?: string | null) => (lang === 'fa' ? fa || en : en || fa) ?? '';
}
/**
 * Persian labels for the status values the database returns.
 *
 * These are enum values, not free text, so they translate safely and completely — and they are the
 * single highest-value thing to translate, because they appear in every row of every table. A
 * Persian screen whose every status column still reads RUNNING / CRITICAL / ACKNOWLEDGED is not a
 * Persian screen.
 *
 * FAT stays as FAT: it is the accepted term in Iranian switchgear practice, like the protocol names
 * elsewhere in this interface. Anything with no entry here falls back to the raw value rather than
 * being hidden, so a status added to the database later still shows up.
 */
export const FA_STATUS: Record<string, string> = {
  PLANNING: 'برنامه‌ریزی',
  ENGINEERING: 'مهندسی',
  PROCUREMENT: 'تأمین',
  MANUFACTURING: 'ساخت',
  FAT: 'FAT',
  INSTALLATION: 'نصب',
  COMMISSIONING: 'راه‌اندازی',
  RUNNING: 'بهره‌برداری',
  COMPLETED: 'تکمیل‌شده',
  BLOCKED: 'متوقف',
  HEALTHY: 'سالم',
  WARNING: 'هشدار',
  ATTENTION: 'نیازمند توجه',
  CRITICAL: 'بحرانی',
  OFFLINE: 'آفلاین',
  ONLINE: 'آنلاین',
  DEGRADED: 'افت‌کرده',
  UNKNOWN: 'نامشخص',
  OPEN: 'باز',
  CLOSED: 'بسته',
  TRIPPED: 'تریپ‌خورده',
  HIGH: 'بالا',
  MEDIUM: 'متوسط',
  LOW: 'پایین',
  INFO: 'اطلاعی',
  UNACKNOWLEDGED: 'تأییدنشده',
  ACKNOWLEDGED: 'تأییدشده',
  INVESTIGATING: 'در حال بررسی',
  RESOLVED: 'رفع‌شده',
  CLOSED_NO_ACTION: 'بسته — بدون اقدام',
  ESCALATED: 'ارجاع‌شده',
  SUPPRESSED: 'سرکوب‌شده',
  ANALYSIS: 'تحلیل',
  ASSIGNED: 'واگذارشده',
  FIELD_INSPECTION: 'بازدید میدانی',
  REPAIR: 'تعمیر',
  TEST: 'تست',
  VERIFIED: 'تأیید نهایی',
};

/**
 * Label for a status enum value, in the current language.
 *
 * Shared by the badges AND by every filter control. They used to be separate: the badge in a table
 * row said «بهره‌برداری» while the filter button above it still said RUNNING, so the two halves of
 * the same screen disagreed about what the same value is called. One dictionary, one hook.
 *
 * Underscores become spaces in English (FIELD_INSPECTION -> FIELD INSPECTION) so untranslated
 * values still read as words rather than identifiers.
 */
export function useStatusLabel() {
  const { lang } = useI18n();
  return (status?: string | null) => {
    if (!status) return '';
    const key = status.toUpperCase();
    if (lang === 'fa' && FA_STATUS[key]) return FA_STATUS[key];
    return status.replace(/_/g, ' ');
  };
}
