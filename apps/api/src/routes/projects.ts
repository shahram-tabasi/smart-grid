import { createRouter } from '../middleware/safeRouter';
import { pool } from '../db/pool';

export const projectsRouter = createRouter();

projectsRouter.get('/', async (req, res) => {
  const { status, provinceId, cityId, search } = req.query as Record<string, string | undefined>;
  const conditions: string[] = [];
  const params: any[] = [];

  if (status) { params.push(status); conditions.push(`p.status = $${params.length}`); }
  if (provinceId) { params.push(provinceId); conditions.push(`p.province_id = $${params.length}`); }
  if (cityId) { params.push(cityId); conditions.push(`p.city_id = $${params.length}`); }
  if (search) { params.push(`%${search}%`); conditions.push(`(p.name ILIKE $${params.length} OR p.code ILIKE $${params.length})`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT p.id, p.code, p.name, cu.name AS customer_name, p.province_id, pr.name_en AS province_name_en,
            pr.name_fa AS province_name_fa, p.city_id, c.name_en AS city_name_en, c.name_fa AS city_name_fa,
            p.project_type, p.voltage_level, p.status,
            p.engineering_progress, p.manufacturing_progress, p.fat_progress, p.installation_progress,
            p.commissioning_progress, p.scada_integration_progress, p.relay_integration_progress,
            p.overall_progress, p.health_score, p.requires_engineering_intervention, p.requires_field_service,
            p.start_date, p.expected_completion, p.actual_completion, p.is_demo_data,
            COALESCE(cs.has_comm_problem, false) AS has_comm_problem
     FROM projects p
     JOIN provinces pr ON pr.id = p.province_id
     JOIN cities c ON c.id = p.city_id
     LEFT JOIN customers cu ON cu.id = p.customer_id
     LEFT JOIN v_project_comm_status cs ON cs.project_id = p.id
     ${where}
     ORDER BY p.code`,
    params
  );
  res.json({ projects: rows, total: rows.length });
});

projectsRouter.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, cu.name AS customer_name, pr.name_en AS province_name_en, pr.name_fa AS province_name_fa,
            c.name_en AS city_name_en, c.name_fa AS city_name_fa,
            pm.full_name AS project_manager_name, tm.full_name AS technical_manager_name
     FROM projects p
     JOIN provinces pr ON pr.id = p.province_id
     JOIN cities c ON c.id = p.city_id
     LEFT JOIN customers cu ON cu.id = p.customer_id
     LEFT JOIN users pm ON pm.id = p.project_manager_id
     LEFT JOIN users tm ON tm.id = p.technical_manager_id
     WHERE p.id::text = $1 OR p.code = $1`,
    [req.params.id]
  );
  const project = rows[0];
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { rows: healthHistory } = await pool.query(
    `SELECT computed_at, overall, technical, communication, protection, progress, risk_level
     FROM project_health_scores WHERE project_id = $1 ORDER BY computed_at DESC LIMIT 12`,
    [project.id]
  );

  res.json({ ...project, healthHistory });
});

// Full equipment hierarchy for a project: Substation -> Switchgear -> Panel -> Breaker -> Relay -> Protection Functions.
projectsRouter.get('/:id/hierarchy', async (req, res) => {
  const { rows: substations } = await pool.query(
    `SELECT id, name, substation_type, voltage_level FROM substations WHERE project_id = $1 ORDER BY name`,
    [req.params.id]
  );
  for (const sub of substations) {
    const { rows: switchgear } = await pool.query(
      `SELECT id, name, voltage_level, switchgear_type, manufacturer FROM switchgear WHERE substation_id = $1 ORDER BY name`,
      [sub.id]
    );
    for (const sg of switchgear) {
      const { rows: panels } = await pool.query(
        `SELECT id, name, panel_type FROM panels WHERE switchgear_id = $1 ORDER BY name`,
        [sg.id]
      );
      for (const panel of panels) {
        const { rows: breakers } = await pool.query(
          `SELECT id, name, breaker_type, status, rated_current_a FROM breakers WHERE panel_id = $1`,
          [panel.id]
        );
        const { rows: relays } = await pool.query(
          `SELECT id, relay_code, manufacturer, model, protocol, comm_status, health_status, health_score,
                  breaker_status, active_setting_group, last_communication_at, last_trip_at, alarm_count, trip_count
           FROM relays WHERE panel_id = $1`,
          [panel.id]
        );
        for (const relay of relays) {
          const { rows: functions } = await pool.query(
            `SELECT function_code, ansi_code, enabled, pickup_value, pickup_unit, time_delay_ms
             FROM protection_functions WHERE relay_id = $1`,
            [relay.id]
          );
          (relay as any).protectionFunctions = functions;
        }
        (panel as any).breakers = breakers;
        (panel as any).relays = relays;
      }
      (sg as any).panels = panels;
    }
    (sub as any).switchgear = switchgear;
  }
  res.json({ substations, isDemoData: true });
});

projectsRouter.get('/:id/work-orders', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT wo.*, u.full_name AS assigned_engineer_name
     FROM work_orders wo LEFT JOIN users u ON u.id = wo.assigned_engineer_id
     WHERE wo.project_id = $1 ORDER BY wo.created_at DESC`,
    [req.params.id]
  );
  res.json({ workOrders: rows });
});
