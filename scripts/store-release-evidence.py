from pathlib import Path
import json,os,subprocess
from public_acceptance_archive import CapturePlan, REPOSITORY, guard, persist, prepare
root=Path.cwd();head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
assert head==os.environ['EXPECTED_CAPSULE_SHA']
def api(method,path,payload=None):
 args=['gh','api',path,'--method',method]
 if payload is not None:args+=['--input','-']
 done=subprocess.run(args,input=json.dumps(payload) if payload is not None else None,text=True,capture_output=True,timeout=45)
 if done.returncode or len(done.stdout)>8*1024*1024:raise RuntimeError('Evidence API failure; inspect immutable ref before retry')
 return json.loads(done.stdout)
ref=guard(dict(os.environ),head,api('GET','repos/'+REPOSITORY));source=os.environ['EXPECTED_SOURCE_SHA'];report=json.loads((root/'test-results/public-boundary/report.json').read_bytes());assert report['source_commit']==source and report['capsule_commit']==head
files,manifest=prepare(root,'public-boundary',source,CapturePlan(content=[],ui=[]));manifest.update(capsule_commit=head,evidence_repository=REPOSITORY,private_source_checks_executed_here=False);files['evidence-manifest.json']=(json.dumps(manifest,indent=2)+'\n').encode();print(json.dumps(persist(api,ref,files)))
