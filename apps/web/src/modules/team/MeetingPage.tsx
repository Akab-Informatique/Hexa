import { useL } from "../../lib/l";
import { PageHeader } from "../../components/ui";
import { Points } from "./meeting/Points";
import { WeekPlanner } from "./meeting/WeekPlanner";
import { Brief, Gauges, Projects, Trends } from "./meeting/Extras";

/**
 * Weekly team meeting, in the reference's order: points and the week planner side by side, the week ahead,
 * the team load gauges, engagements in progress, and trends.
 */
export default function MeetingPage() {
  const l = useL();
  return (
    <>
      <PageHeader title={l("Rencontre hebdomadaire", "Weekly meeting")} subtitle={l("Points à discuter, la semaine, la charge de l'équipe et les tendances", "Points to discuss, the week, the team's load and trends")} />
      <div className="space-y-4">
        <div className="grid items-start gap-4 lg:grid-cols-2"><Points /><WeekPlanner /></div>
        <Brief />
        <Gauges />
        <Projects />
        <Trends />
      </div>
    </>
  );
}
