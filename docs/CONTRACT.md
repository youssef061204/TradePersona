# Implementation contract

The supported input is **one account's sequential completed trades**, one row per realized outcome. `timestamp` is completion time (UTC; naive timestamps assumed UTC). Required: timestamp, quantity (>0), entry_price (>0), profit_loss (finite). Optional: asset, side, holding_minutes (nonnegative), trader_id/account_id (at most one distinct value). This is not an execution-lot reconstruction engine. Missing holding duration yields unavailable holding metrics and abstention because the synthetic benchmark uses disposition evidence. Asset/currency conversion, shorts encoded as negative quantities, overlapping open positions and aggregate multi-account logs are unsupported. Document these limits on upload.

Python owns CSV validation, features, deterministic metrics, prediction, explanations and trends. Node passes raw CSV text to a persistent newline-JSON Python worker (`python -m ml.worker`, cwd backend), no user filenames or filesystem paths. Request `{id,csv}`; response `{id,result}` or `{id,error:{message,quality?}}`. Stdout is protocol only. Python module root backend/ml. Artifact path backend/ml/artifacts/v1/model.joblib and evaluation.json. Model loading is cached, explicit training only.

HTTP: POST `/api/uploads/usertrades` multipart file returns `{sessionId,analysis}`. GET `/api/analysis/:sessionId` returns `{sessionId,analysis}`; delete endpoint optional. GET `/api/evaluation` returns generated evaluation.json. Sessions unguessable, memory-only, TTL 30min, bounded. GET `/healthz`.

Analysis JSON:
```
{schema_version:'1.0', scope:'synthetic benchmark; not validated on real traders',
 quality:{total_rows,usable_rows,malformed_rows,duplicate_rows,missing_fields:[],warnings:[],date_range:{start,end}},
 features:{feature_name:number|null},
 prediction:{status:'classified'|'abstained'|'unavailable',label:string|null,probabilities:{class_key:number},confidence:number|null,margin:number|null,reasons:string[],model_version:string,calibration:string},
 evidence:[{feature:string,label:string,value:number|null,unit:string}],
 explanations:[{feature:string,value:number,reference:number,probability_delta:number}],
 explanation_method:string,
 counterfactuals:[{title:string,description:string,original_probability:number,counterfactual_probability:number,label:string,changed_features:string[]}],
 trends:[{start:string,end:string,trades:number,features:object,prediction:object}],
 coaching:{source:'deterministic',summary:string,actions:string[]},
 alignment:{source:string,dimensions:[{dimension:string,value:number|null,target:number}],disclaimer:string}
}
```
Probabilities are fractions, not percentages. Class keys: `calm_trader`, `loss_aversion`, `overtrader`, `revenge_trader`. Display names: Steady pattern, Longer loss holding, High activity, Post-loss escalation. Do not diagnose psychology. Reasons are readable strings. No probabilities when required information unavailable; low confidence/OOD may include experimental probabilities with abstention prominent.

Evaluation JSON contract (additional fields allowed):
```
{schema_version:'1.0',scope:string,selected_model:string,feature_version:string,
 dataset:{origin:string,unit:string,split_counts:object,classes:string[],fingerprint:string},
 methodology:string,models:[{name:string,validation:{macro_f1,weighted_f1,accuracy,balanced_accuracy}}],
 test:{macro_f1,weighted_f1,accuracy,balanced_accuracy,per_class:{class:{precision,recall,f1,support}},confusion_matrix:number[][],macro_f1_ci95:number[]},
 calibration:{method:string,temperature:number,raw:{brier,ece,log_loss,reliability:[]},calibrated:{brier,ece,log_loss,reliability:[]}},
 coverage:[{threshold:number,coverage:number,accuracy:number|null,macro_f1:number|null}],
 feature_importance:[{feature:string,importance:number}],
 robustness:[{perturbation:string,agreement:number,mean_probability_change:number}],
 shift:{macro_f1,accuracy,...},limitations:string[]}
```
Reliability rows: `{lower,upper,count,confidence,accuracy}`. Headline is selected model's untouched synthetic holdout. Baseline table uses selection validation (all candidates). Coverage includes fixed margin + data/OOD checks, not confidence alone. Counterfactuals recompute all features from modified raw histories, not impossible independently altered feature combinations.
