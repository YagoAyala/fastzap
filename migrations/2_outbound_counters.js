/**
 * Contadores de envio persistidos.
 *
 * O cap por destinatário vivia em memória, então um restart (deploy,
 * crash-loop, OOM) zerava o orçamento — justamente no cenário em que ele mais
 * importa, porque crash-loop + retry é como uma rajada acidental nasce. Um
 * limite que se perde sozinho não é limite.
 *
 * `bucket_key` carrega o escopo e a janela no próprio valor
 * (`d:2026-07-31`, `h:2026-07-31T14`, `r:<jid>:2026-07-31`), então adicionar um
 * novo tipo de cap não exige migração nova.
 */
export const up = (pgm) => {
  pgm.createTable("outbound_counters", {
    session_id: { type: "varchar(100)", notNull: true },
    bucket_key: { type: "varchar(120)", notNull: true },
    count: { type: "integer", notNull: true, default: 0 },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.addConstraint("outbound_counters", "outbound_counters_pkey", {
    primaryKey: ["session_id", "bucket_key"],
  });

  // A poda apaga por janela antiga; sem este índice ela viraria full scan
  // conforme a tabela cresce.
  pgm.createIndex("outbound_counters", "updated_at");
};

export const down = (pgm) => {
  pgm.dropTable("outbound_counters");
};
