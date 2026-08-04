/**
 * Linha de base do vigia de shadowban, persistida.
 *
 * O vigia só alerta se a faixa de hora costumava ter tráfego, e "costumava"
 * exige 3 dias observados na MESMA hora. Esse histórico vivia em memória: o
 * container subiu em 31/07/2026 15:19Z e passou toda a janela pós-migração sem
 * baseline nenhuma, e cada deploy zerava de novo. Um alarme que se desarma
 * sozinho no dia em que o sistema muda é pior que não ter alarme — parece que
 * tem.
 *
 * Duas tabelas porque são dois tempos de vida: `session_health` é estado atual
 * (um registro por sessão, sempre sobrescrito) e `session_health_hours` é
 * histórico observado (uma linha por hora/dia, podado por retenção).
 */
export const up = (pgm) => {
  pgm.createTable("session_health", {
    session_id: { type: "varchar(100)", primaryKey: true, notNull: true },
    last_inbound_at: { type: "timestamptz", notNull: false },
    last_outbound_at: { type: "timestamptz", notNull: false },
    // Guardado para o cooldown do alerta sobreviver a restart: sem isso um
    // crash-loop repetiria o mesmo alerta a cada 5 min.
    alerted_at: { type: "timestamptz", notNull: false },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.createTable("session_health_hours", {
    session_id: { type: "varchar(100)", notNull: true },
    hour: { type: "smallint", notNull: true },
    day: { type: "date", notNull: true },
    count: { type: "integer", notNull: true, default: 0 },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.addConstraint("session_health_hours", "session_health_hours_pkey", {
    primaryKey: ["session_id", "hour", "day"],
  });

  // A poda apaga por dia antigo; sem índice viraria full scan conforme o
  // histórico cresce.
  pgm.createIndex("session_health_hours", "day");
};

export const down = (pgm) => {
  pgm.dropTable("session_health_hours");
  pgm.dropTable("session_health");
};
