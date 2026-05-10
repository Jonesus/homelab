import HADevice from './base.js';
import { allowExtendedType } from '../../util/casting.js';
import AABBDevice from './aabb_device.js';
const ERRORS = [
    'OK',
    'Door lock error (DE2)',
    'Door open error (DE1)',
    'Water supply error (IE)',
    'Water drain error (OE)',
    'Out of balance error (UE)',
    'Overfill error (FE)',
    'Water level sensor error (PE)',
    'Temperature sensor error (TE)',
    'Locked motor error (LE)',
    undefined,
    'Unknown error (dHE)',
    'Power fail error (PF)',
    'Unknown error (FF)',
    'Unknown error (DCE)',
    'Unknown error (AE)',
    'EEPROM error',
    'Unknown error (PS)',
    'Door sensor error (DE4)',
    'Vibration sensor error (VS)',
    'Unknown error (LE8)',
    'Unknown error (LE9)',
    'Unknown error (ED1)',
    'Unknown error (ED2)',
    'Unknown error (ED3)',
    'Unknown error (ED4)',
    'Unknown error (ED5)',
];
const STATES = [
    'Off',
    'Ready',
    'Paused',
    'Delayed',
    'Measuring',
    'Pre-wash',
    'Washing',
    'Rinsing',
    'Spinning',
    'Drying',
    'End',
    'Cooling',
    'Rinse Hold',
    undefined,
    'Refreshing',
    'Steam_softening',
    'Demo',
    undefined,
    'Error',
    'Auto_dt_open_pause',
];
const COURSES = {
    0x1: 'Cotton',
    0x2: 'Easy Care',
    0x4: 'Eco 40-60',
    0x5: 'Duvet',
    0x7: 'Mix',
    0x8: 'Sports Wear',
    0x9: 'Night Wash',
    0xc: 'Quick 14',
    0xd: 'Steam Refresh', // washer/dryer combo (CV74J7S2QA)
    0xe: 'Rinse + Spin',
    0x12: 'Drum Clean',
    0x13: 'Wash + Dry', // washer/dryer combo (CV74J7S2QA)
    0x17: 'Spin + Drain',
    0x18: 'Dry Only', // washer/dryer combo (CV74J7S2QA)
    0x1b: 'Hand Wash/Wool',
    0x20: 'Delicate',
    0x2d: 'Allergy Care',
    0x31: 'TurboWash 39',
    0x37: 'ezDispense Nozzle Clean', // washer/dryer combo (CV74J7S2QA)
};
const TEMPERATURES = [0, 10, 20, 30, 40, 50, 60, 95];
const SPINS = [undefined, 0, 400, 500, 700, 800, 900, 1000, 1100, 1200, 1400];
const DOSES = ['Off', 'Low', 'Medium', 'High'];
const DRY_MODES = {
    0x2: 'Auto',
    0x3: '30 min',
    0x4: '60 min',
    0x6: '120 min',
    0xa: 'Iron Dry',
    0xb: 'Sensor Dry',
};
export default class Device extends AABBDevice {
    constructor(HA, thinq, meta) {
        super(HA, thinq);
        this.setConfig(allowExtendedType({
            ...HADevice.config(meta, { name: 'LG F4WV709P1E' }),
            components: {
                power: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-power',
                    state_topic: '$this/power',
                    name: 'Power',
                    icon: 'mdi:washing-machine',
                },
                status: {
                    platform: 'sensor',
                    unique_id: '$deviceid-status',
                    state_topic: '$this/status',
                    name: 'Status',
                    icon: 'mdi:state-machine',
                    device_class: 'enum',
                    options: STATES.filter((a) => a !== undefined),
                },
                error: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-error',
                    state_topic: '$this/error',
                    name: 'Error',
                    icon: 'mdi:check-circle',
                    device_class: 'problem',
                    entity_category: 'diagnostic',
                },
                error_message: {
                    platform: 'sensor',
                    unique_id: '$deviceid-error-message',
                    state_topic: '$this/error_message',
                    name: 'Error message',
                    icon: 'mdi:alert-circle-outline',
                    device_class: 'enum',
                    entity_category: 'diagnostic',
                    options: ERRORS.filter((a) => a !== undefined),
                },
                course: {
                    platform: 'sensor',
                    unique_id: '$deviceid-course',
                    state_topic: '$this/course',
                    name: 'Course',
                    icon: 'mdi:pin-outline',
                },
                temp: {
                    platform: 'sensor',
                    unique_id: '$deviceid-temp',
                    state_topic: '$this/temp',
                    name: 'Temperature',
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    suggested_display_precision: 0,
                    value_template: "{{ value if value | is_number else 'None' }}",
                },
                spin: {
                    platform: 'sensor',
                    unique_id: '$deviceid-spin',
                    state_topic: '$this/spin',
                    name: 'Spin',
                    icon: 'mdi:autorenew',
                    unit_of_measurement: 'RPM',
                    value_template: "{{ value if value | is_number else 'None' }}",
                },
                cycles: {
                    platform: 'sensor',
                    unique_id: '$deviceid-cycles',
                    state_topic: '$this/cycles',
                    name: 'Cycle count',
                    icon: 'mdi:rotate-3d-variant',
                },
                energy: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy',
                    state_topic: '$this/energy',
                    name: 'Energy',
                    icon: 'mdi:lightning-bolt',
                    device_class: 'energy',
                    state_class: 'total_increasing',
                    unit_of_measurement: 'Wh',
                },
                remaining_time: {
                    platform: 'sensor',
                    unique_id: '$deviceid-remaining_time',
                    state_topic: '$this/remaining_time',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    name: 'Remaining time',
                },
                delay_end: {
                    platform: 'sensor',
                    unique_id: '$deviceid-delay-end',
                    state_topic: '$this/delay_end',
                    name: 'Delay end',
                    icon: 'mdi:timer-sand',
                    unit_of_measurement: 'h',
                    suggested_display_precision: 0,
                },
                detergent: {
                    platform: 'sensor',
                    unique_id: '$deviceid-detergent',
                    state_topic: '$this/detergent',
                    name: 'Detergent dose',
                    icon: 'mdi:cup',
                    device_class: 'enum',
                    options: DOSES,
                },
                softener: {
                    platform: 'sensor',
                    unique_id: '$deviceid-softener',
                    state_topic: '$this/softener',
                    name: 'Softener dose',
                    icon: 'mdi:cup-outline',
                    device_class: 'enum',
                    options: DOSES,
                },
                turbowash: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-turbowash',
                    state_topic: '$this/turbowash',
                    name: 'TurboWash',
                    icon: 'mdi:rocket-launch',
                },
                eco_hybrid: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-eco-hybrid',
                    state_topic: '$this/eco_hybrid',
                    name: 'EcoHybrid',
                    icon: 'mdi:leaf',
                },
                prewash: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-prewash',
                    state_topic: '$this/prewash',
                    name: 'Pre-wash',
                    icon: 'mdi:water-sync',
                },
                steam: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-steam',
                    state_topic: '$this/steam',
                    name: 'Steam',
                    icon: 'mdi:kettle-steam',
                },
                extra_rinse: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-extra-rinse',
                    state_topic: '$this/extra_rinse',
                    name: 'Extra rinse',
                    icon: 'mdi:water-plus',
                },
                dry: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-dry',
                    state_topic: '$this/dry',
                    name: 'Wash + Dry',
                    icon: 'mdi:tumble-dryer',
                },
                dry_mode: {
                    platform: 'sensor',
                    unique_id: '$deviceid-dry-mode',
                    state_topic: '$this/dry_mode',
                    name: 'Dry mode',
                    icon: 'mdi:tumble-dryer',
                    device_class: 'enum',
                    options: ['Off', ...Object.values(DRY_MODES)],
                },
                remote_start: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-remote-start',
                    state_topic: '$this/remote_start',
                    name: 'Remote Start',
                    icon: 'mdi:remote',
                },
                child_lock: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-child-lock',
                    state_topic: '$this/child_lock',
                    name: 'Child lock',
                    icon: 'mdi:lock',
                },
            },
        }));
    }
    start() {
        // this is only *slightly* different to the init string for the fridge
        this.send(Buffer.from('F0ED1121010000001800', 'hex'));
    }
    processAABB(buf) {
        if (buf.length === 80 && buf[0] == 0x20) {
            const status = buf[43];
            const error = buf[49];
            const tremain = buf[44] * 60 + buf[45];
            const course = buf[48];
            const temp = buf[52];
            const spin = buf[51];
            const cycles = buf[64];
            const energy = buf[71] * 256 + buf[72];
            // Reverse-engineered on a CV74J7S2QA washer/dryer combo.
            // Most of these are option toggles surfaced through the panel
            // buttons; the firmware greys them out per-program when an
            // option doesn't apply, so on washer-only F_V8 models the bits
            // simply never set.
            const flags1 = buf[57]; // option bitfield 1
            const flags2 = buf[58]; // option bitfield 2
            const dryRequested = buf[54] >= 2;
            const dryMode = DRY_MODES[buf[54]] ?? 'Off';
            const extraRinse = buf[53] >= 2;
            const delayEnd = buf[55]; // hours, 0 = off (range 3..19 when set)
            const detergent = buf[73]; // 0=Off, 1=Low, 2=Medium, 3=High
            const softener = buf[74]; // same encoding as detergent
            this.publishProperty('power', status > 0 ? 'ON' : 'OFF');
            this.publishProperty('error_message', ERRORS[error] ?? 'unknown');
            this.publishProperty('error', error ? 'ON' : 'OFF');
            this.publishProperty('status', STATES[status] ?? 'unknown');
            this.publishProperty('course', COURSES[course] ?? 'unknown');
            this.publishProperty('temp', TEMPERATURES[temp] ?? 'unknown');
            this.publishProperty('spin', SPINS[spin] ?? 'unknown');
            this.publishProperty('cycles', cycles);
            this.publishProperty('energy', energy);
            this.publishProperty('remaining_time', tremain);
            this.publishProperty('delay_end', delayEnd);
            this.publishProperty('detergent', DOSES[detergent] ?? 'unknown');
            this.publishProperty('softener', DOSES[softener] ?? 'unknown');
            this.publishProperty('turbowash', flags1 & 0x01 ? 'ON' : 'OFF');
            this.publishProperty('eco_hybrid', flags1 & 0x08 ? 'ON' : 'OFF');
            this.publishProperty('prewash', flags1 & 0x40 ? 'ON' : 'OFF');
            this.publishProperty('steam', flags1 & 0x80 ? 'ON' : 'OFF');
            this.publishProperty('extra_rinse', extraRinse ? 'ON' : 'OFF');
            this.publishProperty('dry', dryRequested ? 'ON' : 'OFF');
            this.publishProperty('dry_mode', dryMode);
            this.publishProperty('remote_start', flags2 & 0x02 ? 'ON' : 'OFF');
            this.publishProperty('child_lock', flags2 & 0x80 ? 'ON' : 'OFF');
        }
    }
}
