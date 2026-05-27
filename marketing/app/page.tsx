import { Hero } from "@/components/home/hero"
import { Integrations } from "@/components/home/integrations"
import { AgentsShowcase } from "@/components/home/agents-showcase"
import { Marquee } from "@/components/home/marquee"
import { Manifesto } from "@/components/home/manifesto"
import { HowItWorks } from "@/components/home/how-it-works"
import { ShowReel } from "@/components/home/showreel"
import { WhisperDemo } from "@/components/home/whisper-demo"
import { SocialProof } from "@/components/home/social-proof"
import { WhyDifferent } from "@/components/home/why-different"
import { CTA } from "@/components/home/cta"

export default function HomePage() {
  return (
    <>
      <Hero />
      <Integrations />
      <AgentsShowcase />
      <Marquee />
      <Manifesto />
      <HowItWorks />
      <ShowReel />
      <WhisperDemo />
      <SocialProof />
      <WhyDifferent />
      <CTA />
    </>
  )
}
