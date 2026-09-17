import { SampleProvider } from "@/components/systems/shared/runtime/sample-state";
export default function SampleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SampleProvider>{children}</SampleProvider>;
}
