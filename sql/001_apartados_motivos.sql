-- Motivos de "Otros" como categorías de verdad (8 de octubre de 2026)
--
-- Hasta hoy el motivo de un pago apartado como "Otros" era texto libre en
-- `pagos_apartados.nota`: 111 pagos con 28 notas distintas, de las cuales
-- "Certificado" estaba escrita de NUEVE formas (63 pagos). Así no se podía
-- filtrar ni contar nada.
--
-- Esta tabla es el catálogo: lo que la persona elige al apartar. El motivo de
-- cada pago sigue viviendo en `pagos_apartados.nota` (no se agrega columna), y
-- el `tipo` sigue siendo 'otros' — o sea que NO hace falta tocar el
-- `pagos_apartados_tipo_check` ni el pipeline: `cruzar.py` saca del proceso a
-- todo lo que esté en `pagos_apartados`, sin mirar el tipo.

create table if not exists apartados_motivos (
  nombre      text primary key,
  activo      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  text
);

alter table apartados_motivos enable row level security;

-- El catálogo arranca con los motivos que el área YA venía usando, para que la
-- lista no nazca vacía. Los que son de un solo caso y narran algo ("Pago ya
-- identificado 19/08/2026") se dejan fuera a propósito: no son categorías.
insert into apartados_motivos (nombre, created_by) values
  ('Certificado',           'migracion'),
  ('Nequi',                 'migracion'),
  ('D.G',                   'migracion'),
  ('Pago errado',           'migracion'),
  ('Transferencia interna', 'migracion'),
  ('Ya cruzado',            'migracion'),
  ('Compensado',            'migracion'),
  ('Supletorios',           'migracion'),
  ('Varias INC',            'migracion'),
  ('Sin identificar',       'migracion'),
  ('Correo inválido',       'migracion'),
  ('Repetido día anterior', 'migracion')
on conflict (nombre) do nothing;

-- Las NUEVE formas de escribir "Certificado", a una sola (63 pagos). Solo se
-- colapsan variantes de ortografía y puntuación: "Posible certificado" NO entra
-- acá, porque significa otra cosa (no estaban seguros).
update pagos_apartados
   set nota = 'Certificado'
 where tipo = 'otros'
   and nota in ('Certificación', 'Certificación.', 'Certificado', 'Certificado.',
                'Certificados', 'Certificados.', 'Certificvación');

update pagos_apartados set nota = 'Varias INC'      where tipo = 'otros' and nota in ('Varias INC', 'Varias INC a cruzar.');
update pagos_apartados set nota = 'Sin identificar' where tipo = 'otros' and nota in ('Sin identificar.');
update pagos_apartados set nota = 'Correo inválido' where tipo = 'otros' and nota in ('Correo invalido');

-- ⚠️ Lo que NO se toca, porque es decisión del área y no de ortografía: hay 2
-- pagos apartados como "Otros" con la nota "Cesantías" y 2 con "QR"/"Llave",
-- que son tipos que ya existen por su cuenta. Cambiarles el `tipo` es moverlos
-- de categoría, no corregirles el texto.
