"""Canonicalize decimal field configuration and record values."""

from collections.abc import Sequence

from alembic import op

revision = "20260831_0015"
down_revision = "20260830_0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _create_upgrade_function() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION pg_temp.openslate_decimal_to_canonical_text(
            p_value numeric
        )
        RETURNS text
        LANGUAGE plpgsql
        IMMUTABLE
        STRICT
        AS $function$
        DECLARE
            rendered text;
            integer_part text;
            fractional_part text;
        BEGIN
            IF p_value = 0 THEN
                RETURN '0';
            END IF;

            rendered := trim_scale(p_value)::text;
            IF rendered !~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?$' THEN
                RAISE EXCEPTION
                    'Decimal value cannot be represented by the canonical decimal grammar';
            END IF;

            integer_part := split_part(ltrim(rendered, '-'), '.', 1);
            fractional_part := CASE
                WHEN strpos(rendered, '.') > 0 THEN split_part(rendered, '.', 2)
                ELSE ''
            END;
            IF length(integer_part) > 38 OR length(fractional_part) > 18 THEN
                RAISE EXCEPTION
                    'Decimal value exceeds canonical precision or scale';
            END IF;

            RETURN rendered;
        END
        $function$;
        """
    )


def _preflight_upgrade() -> None:
    op.execute(
        """
        DO $preflight$
        DECLARE
            decimal_bound record;
            decimal_value record;
        BEGIN
            IF EXISTS (
                SELECT 1
                  FROM public.fields AS f
                 WHERE f.type = 'decimal'
                   AND jsonb_typeof(f.config) IS DISTINCT FROM 'object'
            ) THEN
                RAISE EXCEPTION 'A decimal field has a non-object config';
            END IF;

            IF EXISTS (
                SELECT 1
                  FROM public.fields AS f
                 WHERE f.type = 'decimal'
                   AND (
                       (f.config ? 'minimum'
                        AND jsonb_typeof(f.config -> 'minimum') NOT IN ('number', 'null'))
                       OR
                       (f.config ? 'maximum'
                        AND jsonb_typeof(f.config -> 'maximum') NOT IN ('number', 'null'))
                   )
            ) THEN
                RAISE EXCEPTION 'A decimal field has a bound with an invalid JSON type';
            END IF;

            FOR decimal_bound IN
                SELECT f.id AS field_id,
                       config_entry.key AS bound_name,
                       config_entry.value AS bound_value
                  FROM public.fields AS f
                  CROSS JOIN LATERAL jsonb_each(f.config) AS config_entry(key, value)
                 WHERE f.type = 'decimal'
                   AND config_entry.key IN ('minimum', 'maximum')
                   AND jsonb_typeof(config_entry.value) = 'number'
            LOOP
                PERFORM pg_temp.openslate_decimal_to_canonical_text(
                    (decimal_bound.bound_value #>> '{}')::numeric
                );
            END LOOP;

            IF EXISTS (
                SELECT 1
                  FROM public.records AS r
                  JOIN public.fields AS f
                    ON f.type = 'decimal'
                   AND r.data ? f.id::text
                 WHERE jsonb_typeof(r.data -> f.id::text) NOT IN ('number', 'null')
            ) THEN
                RAISE EXCEPTION 'A decimal record value has an invalid JSON type';
            END IF;

            FOR decimal_value IN
                SELECT r.id AS record_id,
                       f.id AS field_id,
                       r.data -> f.id::text AS field_value
                  FROM public.records AS r
                  JOIN public.fields AS f
                    ON f.type = 'decimal'
                   AND r.data ? f.id::text
                 WHERE jsonb_typeof(r.data -> f.id::text) = 'number'
            LOOP
                PERFORM pg_temp.openslate_decimal_to_canonical_text(
                    (decimal_value.field_value #>> '{}')::numeric
                );
            END LOOP;
        END
        $preflight$;
        """
    )


def _upgrade_values() -> None:
    op.execute(
        """
        UPDATE public.fields AS f
           SET config = jsonb_set(
               jsonb_set(
                   f.config,
                   '{minimum}',
                   CASE
                       WHEN f.config ? 'minimum'
                            AND jsonb_typeof(f.config -> 'minimum') = 'number'
                       THEN to_jsonb(
                           pg_temp.openslate_decimal_to_canonical_text(
                               (f.config ->> 'minimum')::numeric
                           )
                       )
                       ELSE COALESCE(f.config -> 'minimum', 'null'::jsonb)
                   END,
                   false
               ),
               '{maximum}',
               CASE
                   WHEN f.config ? 'maximum'
                        AND jsonb_typeof(f.config -> 'maximum') = 'number'
                   THEN to_jsonb(
                       pg_temp.openslate_decimal_to_canonical_text(
                           (f.config ->> 'maximum')::numeric
                       )
                   )
                   ELSE COALESCE(f.config -> 'maximum', 'null'::jsonb)
               END,
               false
           )
         WHERE f.type = 'decimal'
           AND (f.config ? 'minimum' OR f.config ? 'maximum');

        UPDATE public.records AS r
           SET data = converted.data
          FROM (
              SELECT r.id,
                     jsonb_object_agg(
                         entry.key,
                         CASE
                             WHEN f.id IS NOT NULL
                                  AND jsonb_typeof(entry.value) = 'number'
                             THEN to_jsonb(
                                 pg_temp.openslate_decimal_to_canonical_text(
                                     (entry.value #>> '{}')::numeric
                                 )
                             )
                             ELSE entry.value
                         END
                     ) AS data
                FROM public.records AS r
                CROSS JOIN LATERAL jsonb_each(r.data) AS entry(key, value)
                LEFT JOIN public.fields AS f
                  ON f.id::text = entry.key
                 AND f.type = 'decimal'
               WHERE EXISTS (
                   SELECT 1
                     FROM public.fields AS decimal_field
                    WHERE decimal_field.type = 'decimal'
                      AND r.data ? decimal_field.id::text
               )
               GROUP BY r.id
          ) AS converted
         WHERE r.id = converted.id;
        """
    )


def _create_downgrade_function() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION pg_temp.openslate_canonical_text_to_decimal(
            p_value text
        )
        RETURNS numeric
        LANGUAGE plpgsql
        IMMUTABLE
        STRICT
        AS $function$
        DECLARE
            integer_part text;
            fractional_part text;
            normalized text;
        BEGIN
            IF p_value !~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?$' THEN
                RAISE EXCEPTION
                    'Decimal string is not in the canonical decimal grammar';
            END IF;

            integer_part := split_part(ltrim(p_value, '-'), '.', 1);
            fractional_part := CASE
                WHEN strpos(p_value, '.') > 0 THEN split_part(p_value, '.', 2)
                ELSE ''
            END;
            IF length(integer_part) > 38 OR length(fractional_part) > 18 THEN
                RAISE EXCEPTION
                    'Decimal string exceeds canonical precision or scale';
            END IF;

            normalized := trim_scale(p_value::numeric)::text;
            IF normalized <> p_value THEN
                RAISE EXCEPTION 'Decimal string is not canonical';
            END IF;

            RETURN p_value::numeric;
        END
        $function$;
        """
    )


def _preflight_downgrade() -> None:
    op.execute(
        """
        DO $preflight$
        DECLARE
            decimal_bound record;
            decimal_value record;
        BEGIN
            IF EXISTS (
                SELECT 1
                  FROM public.fields AS f
                 WHERE f.type = 'decimal'
                   AND jsonb_typeof(f.config) IS DISTINCT FROM 'object'
            ) THEN
                RAISE EXCEPTION 'A decimal field has a non-object config';
            END IF;

            IF EXISTS (
                SELECT 1
                  FROM public.fields AS f
                 WHERE f.type = 'decimal'
                   AND (
                       (f.config ? 'minimum'
                        AND jsonb_typeof(f.config -> 'minimum') NOT IN ('string', 'null'))
                       OR
                       (f.config ? 'maximum'
                        AND jsonb_typeof(f.config -> 'maximum') NOT IN ('string', 'null'))
                   )
            ) THEN
                RAISE EXCEPTION 'A decimal field has a bound that is not canonical text';
            END IF;

            FOR decimal_bound IN
                SELECT f.id AS field_id,
                       config_entry.key AS bound_name,
                       config_entry.value AS bound_value
                  FROM public.fields AS f
                  CROSS JOIN LATERAL jsonb_each(f.config) AS config_entry(key, value)
                 WHERE f.type = 'decimal'
                   AND config_entry.key IN ('minimum', 'maximum')
                   AND jsonb_typeof(config_entry.value) = 'string'
            LOOP
                PERFORM pg_temp.openslate_canonical_text_to_decimal(
                    decimal_bound.bound_value #>> '{}'
                );
            END LOOP;

            IF EXISTS (
                SELECT 1
                  FROM public.records AS r
                  JOIN public.fields AS f
                    ON f.type = 'decimal'
                   AND r.data ? f.id::text
                 WHERE jsonb_typeof(r.data -> f.id::text) NOT IN ('string', 'null')
            ) THEN
                RAISE EXCEPTION 'A decimal record value is not canonical text';
            END IF;

            FOR decimal_value IN
                SELECT r.id AS record_id,
                       f.id AS field_id,
                       r.data -> f.id::text AS field_value
                  FROM public.records AS r
                  JOIN public.fields AS f
                    ON f.type = 'decimal'
                   AND r.data ? f.id::text
                 WHERE jsonb_typeof(r.data -> f.id::text) = 'string'
            LOOP
                PERFORM pg_temp.openslate_canonical_text_to_decimal(
                    decimal_value.field_value #>> '{}'
                );
            END LOOP;
        END
        $preflight$;
        """
    )


def _downgrade_values() -> None:
    op.execute(
        """
        UPDATE public.fields AS f
           SET config = jsonb_set(
               jsonb_set(
                   f.config,
                   '{minimum}',
                   CASE
                       WHEN f.config ? 'minimum'
                            AND jsonb_typeof(f.config -> 'minimum') = 'string'
                       THEN to_jsonb(
                           pg_temp.openslate_canonical_text_to_decimal(
                               f.config ->> 'minimum'
                           )
                       )
                       ELSE COALESCE(f.config -> 'minimum', 'null'::jsonb)
                   END,
                   false
               ),
               '{maximum}',
               CASE
                   WHEN f.config ? 'maximum'
                        AND jsonb_typeof(f.config -> 'maximum') = 'string'
                   THEN to_jsonb(
                       pg_temp.openslate_canonical_text_to_decimal(
                           f.config ->> 'maximum'
                       )
                   )
                   ELSE COALESCE(f.config -> 'maximum', 'null'::jsonb)
               END,
               false
           )
         WHERE f.type = 'decimal'
           AND (f.config ? 'minimum' OR f.config ? 'maximum');

        UPDATE public.records AS r
           SET data = converted.data
          FROM (
              SELECT r.id,
                     jsonb_object_agg(
                         entry.key,
                         CASE
                             WHEN f.id IS NOT NULL
                                  AND jsonb_typeof(entry.value) = 'string'
                             THEN to_jsonb(
                                 pg_temp.openslate_canonical_text_to_decimal(
                                     entry.value #>> '{}'
                                 )
                             )
                             ELSE entry.value
                         END
                     ) AS data
                FROM public.records AS r
                CROSS JOIN LATERAL jsonb_each(r.data) AS entry(key, value)
                LEFT JOIN public.fields AS f
                  ON f.id::text = entry.key
                 AND f.type = 'decimal'
               WHERE EXISTS (
                   SELECT 1
                     FROM public.fields AS decimal_field
                    WHERE decimal_field.type = 'decimal'
                      AND r.data ? decimal_field.id::text
               )
               GROUP BY r.id
          ) AS converted
         WHERE r.id = converted.id;
        """
    )


def upgrade() -> None:
    _create_upgrade_function()
    _preflight_upgrade()
    _upgrade_values()
    op.execute("DROP FUNCTION pg_temp.openslate_decimal_to_canonical_text(numeric)")


def downgrade() -> None:
    _create_downgrade_function()
    _preflight_downgrade()
    _downgrade_values()
    op.execute("DROP FUNCTION pg_temp.openslate_canonical_text_to_decimal(text)")
