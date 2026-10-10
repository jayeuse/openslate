"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";

import {
  ChartContainer,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export type OpenViewChartDatum = {
  key: string;
  label: string;
  value: number | null;
};

export function OpenViewChartPreview({
  data,
  type,
  valueLabel,
  showLabels = true,
  showPoints = showLabels,
  showLegend = true,
  allowDecimals = true,
  className = "border-border/70 bg-muted/15 h-[20rem] w-full rounded-[var(--radius)] border p-3",
  barRadius = 7,
  maxBarSize = 58,
  pieInnerRadius = 62,
  pieOuterRadius = 96,
}: {
  data: OpenViewChartDatum[];
  type: "bar" | "line" | "pie";
  valueLabel: string;
  showLabels?: boolean;
  showPoints?: boolean;
  showLegend?: boolean;
  allowDecimals?: boolean;
  className?: string;
  barRadius?: number;
  maxBarSize?: number;
  pieInnerRadius?: number;
  pieOuterRadius?: number;
}) {
  const points =
    type === "line" ? data : data.filter((item) => item.value !== null);
  const config: ChartConfig = {
    value: { label: valueLabel, color: "var(--chart-1)" },
    ...Object.fromEntries(
      points.map((item, index) => [
        item.key,
        {
          label: item.label,
          color: `var(--chart-${(index % 5) + 1})`,
        },
      ]),
    ),
  };
  const margin = {
    top: showLabels ? 24 : 8,
    right: 12,
    left: 0,
    bottom: 8,
  };

  return (
    <ChartContainer config={config} className={className}>
      {type === "bar" ? (
        <BarChart accessibilityLayer data={points} margin={margin}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            allowDecimals={allowDecimals}
            tickLine={false}
            axisLine={false}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          {showLegend ? <Legend content={<ChartLegendContent />} /> : null}
          <Bar
            dataKey="value"
            isAnimationActive={false}
            radius={[barRadius, barRadius, 0, 0]}
            maxBarSize={maxBarSize}
          >
            {points.map((item) => (
              <Cell key={item.key} fill={`var(--color-${item.key})`} />
            ))}
            {showLabels ? <LabelList dataKey="value" position="top" /> : null}
          </Bar>
        </BarChart>
      ) : type === "line" ? (
        <LineChart accessibilityLayer data={points} margin={margin}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            allowDecimals={allowDecimals}
            tickLine={false}
            axisLine={false}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          {showLegend ? <Legend content={<ChartLegendContent />} /> : null}
          <Line
            dataKey="value"
            isAnimationActive={false}
            connectNulls={false}
            type="monotone"
            stroke="var(--color-value)"
            strokeWidth={3}
            dot={
              showPoints
                ? {
                    r: 5,
                    fill: "var(--color-value)",
                    stroke: "var(--background)",
                    strokeWidth: 2,
                  }
                : false
            }
            activeDot={{ r: 7 }}
          >
            {showLabels ? <LabelList dataKey="value" position="top" /> : null}
          </Line>
        </LineChart>
      ) : (
        <PieChart accessibilityLayer>
          <ChartTooltip content={<ChartTooltipContent nameKey="label" />} />
          {showLegend ? (
            <Legend content={<ChartLegendContent nameKey="label" />} />
          ) : null}
          <Pie
            data={points}
            isAnimationActive={false}
            dataKey="value"
            nameKey="label"
            innerRadius={pieInnerRadius}
            outerRadius={pieOuterRadius}
            paddingAngle={3}
            stroke="var(--background)"
            strokeWidth={2}
            label={
              showLabels
                ? ({ name, value }) => `${String(name ?? "Group")}: ${value}`
                : false
            }
          >
            {points.map((item) => (
              <Cell key={item.key} fill={`var(--color-${item.key})`} />
            ))}
          </Pie>
        </PieChart>
      )}
    </ChartContainer>
  );
}
