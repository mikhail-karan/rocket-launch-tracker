import { SkyGuideApp } from "@/components/sky-guide-app";
import { missionConfig } from "@/lib/mission-config";

export default function Home() {
  return <SkyGuideApp missionConfig={missionConfig} />;
}
