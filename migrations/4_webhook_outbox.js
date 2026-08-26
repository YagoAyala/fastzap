export const up = (pgm) => {
  pgm.createTable("webhook_outbox", {
    id: { type: "bigserial", primaryKey: true },
    lane: { type: "varchar(16)", notNull: true },
    phone: { type: "varchar(64)", notNull: false },
    message_id: { type: "varchar(255)", notNull: false },
    payload: { type: "jsonb", notNull: true },
    status: { type: "varchar(16)", notNull: true, default: "pending" },
    attempts: { type: "integer", notNull: true, default: 0 },
    last_error: { type: "text", notNull: false },
    next_attempt_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    delivered_at: { type: "timestamptz", notNull: false },
  });

  pgm.createIndex("webhook_outbox", ["next_attempt_at"], {
    name: "webhook_outbox_pending_idx",
    where: "status = 'pending'",
  });

  pgm.createIndex("webhook_outbox", ["delivered_at"], {
    name: "webhook_outbox_prune_idx",
    where: "status = 'delivered'",
  });
};

export const down = (pgm) => {
  pgm.dropTable("webhook_outbox");
};
