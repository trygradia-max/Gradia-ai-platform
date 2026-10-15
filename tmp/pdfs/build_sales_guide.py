from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, Color
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
import pdfplumber

OUT='/Users/harryhatch/Gradia/platform/output/pdf/zivance_sales_process.pdf'
c=canvas.Canvas(OUT,pagesize=(1200,820))
c.setTitle('Zivance | Sales process - team review draft')
navy='#142D39'; muted='#59717B'; teal='#087F78'; line='#D4E2E3'
def box(x,y,w,h,fill,stroke=None,r=12):
    c.setFillColor(HexColor(fill)); c.setStrokeColor(HexColor(stroke or fill))
    c.roundRect(x,y,w,h,r,fill=1,stroke=bool(stroke))
def txt(x,y,s,size=12,color=navy,bold=False):
    c.setFillColor(HexColor(color)); c.setFont('Helvetica-Bold' if bold else 'Helvetica',size); c.drawString(x,y,s)
def para(x,top,w,s,size=12,color=muted,leading=None):
    p=Paragraph(s,ParagraphStyle('p',fontName='Helvetica',fontSize=size,leading=leading or size*1.4,textColor=HexColor(color)))
    _,h=p.wrap(w,1000); p.drawOn(c,x,top-h); return h
def arrow(x1,y,x2):
    c.setStrokeColor(HexColor(teal)); c.setLineWidth(2); c.line(x1,y,x2-5,y)
    p=c.beginPath();p.moveTo(x2-6,y+4);p.lineTo(x2,y);p.lineTo(x2-6,y-4);p.close()
    c.setFillColor(HexColor(teal));c.drawPath(p,fill=1,stroke=0)

box(0,0,1200,820,'#F6F9F9',r=0)
txt(42,775,'ZIVANCE',14,teal,True)
box(944,756,214,29,'#E8EFF0',r=14);txt(961,766,'DRAFT FOR TEAM REVIEW',10,muted,True)
txt(42,724,'From warm lead to closed deal',32,navy,True)
txt(42,696,'A practical guide for the sales team: who owns each step and what happens next.',14,muted)
txt(42,660,'01  THE SALES FLOW',11,teal,True)
txt(864,660,'Proposed order - confirm before rollout',10,muted)

stages=[
 ('1','Generate leads','MARKETING','Meta ads bring in<br/>warm leads.','NEXT','Pass the lead to a setter.'),
 ('2','Book the meeting','SETTER','Contact the lead and<br/>agree a meeting time.','HANDOFF','Share contact details, needs and meeting time with the closer.'),
 ('3','Run the sales call','CLOSER','Understand the need,<br/>present the offer and<br/>agree the next step.','NEXT','Record the outcome and follow up if needed.'),
 ('4','Close the deal','CLOSER','Confirm the customer\'s<br/>agreement and record<br/>the deal as won.','HANDOFF',"Confirm payment instructions and the customer's next step."),
 ('5','Complete handoff','CLOSER','Confirm payment status<br/>and hand over the<br/>customer details.','NEXT','Keep the deal record current so the team can take over.')]
for i,(n,title,owner,body,tag,nxt) in enumerate(stages):
    x=42+i*228
    box(x,401,204,238,'#FFFFFF',line)
    box(x+16,594,28,28,teal,r=14);txt(x+25,603,n,12,'#FFFFFF',True)
    txt(x+16,573,owner,9,teal,True)
    txt(x+16,548,title,16,navy,True)
    para(x+16,532,172,body,12)
    txt(x+16,464,tag,9,muted,True)
    para(x+16,454,172,nxt,11)
    if i<4: arrow(x+206,520,x+225)

box(42,322,1116,63,'#E6F1EF')
txt(58,362,'IF THE DEAL DOES NOT MOVE FORWARD',10,teal,True)
para(58,349,1082,'Suggested follow-up: <b>No reply / no-show</b> - setter follows up and rebooks.  <b>Not ready to buy</b> - closer agrees a follow-up date.  <b>Not a fit</b> - record the reason and close the lead.',11,navy)

txt(42,292,'02  YOUR COMMISSION',11,teal,True)
txt(42,271,'Your role and rate. Confirm the calculation basis and payment schedule with your sales lead.',11,muted)
parts=[('25%','Closer','Per deal'),('15%','Setter','Per closed deal')]
for i,(pct,label,note) in enumerate(parts):
    x=42+i*564
    box(x,157,552,94,'#FFFFFF',line)
    txt(x+20,194,pct,32,teal,True)
    txt(x+129,211,label,16,navy,True)
    para(x+129,199,380,note,12)

box(42,49,1116,91,'#E8EFF0')
txt(58,119,'A GOOD HANDOFF KEEPS THE DEAL MOVING',10,teal,True)
para(58,107,1082,'Always record: <b>customer name and contact details</b> / <b>what they need</b> / <b>assigned setter and closer</b> / <b>latest outcome</b> / <b>next action, owner and date</b>.',12,navy)
para(58,71,1082,'Team review: confirm the proposed responsibilities, commission calculation basis and payout timing with your sales lead.',10,muted)
txt(42,25,'Based on the supplied Film Video / GC deal-flow chart. Internal working draft.',9,muted)
txt(1084,25,'ZIVANCE  /  1',9,muted)
c.save()
with pdfplumber.open(OUT) as doc:
    assert len(doc.pages)==1
    doc.pages[0].to_image(resolution=110).save('/Users/harryhatch/Gradia/platform/tmp/pdfs/zivance_sales_process.png')
print(OUT)
