import { SampleProvider } from "@/components/sample/sample-state";
export default function SampleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SampleProvider>{children}</SampleProvider>;
}
