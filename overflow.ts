// this just bugs me
Symbol.prototype.toString = function() { return this.description!; };

// anything that can be evaluated to get a value
type Expression = symbol | IExpr;
interface IExpr {
    checkExprType(env: Environment): Type;
    evalExpr(env: Environment): Value;
}
// anything that can be evaluated to do something
type Statement = IStmt;
interface IStmt {
    checkStmtType(env: Environment): Environment;
    evalStmt(env: Environment): Environment;
}
// anything that can be used as a type
// `symbol` appears again, because a symbol could point to a class
type Type = symbol | IType;
interface IType {
    isSameType(b: Type, env: Environment): boolean;
    formatType(env: Environment, resolving: Set<symbol>): string;
}
function asType(x: IExpr) {
    if(!("isSameType" in x)) throw new Error(`${x.toString()} isn't even remotely like a Type`);
    return x as unknown as IType;
}
function isType(x: IExpr): x is (IExpr & IType) { return "isSameType" in x; }

abstract class Thing implements IExpr {
    private readonly _thing!: void;
    abstract isSameThing(b: Thing, env: Environment): boolean;
    abstract checkExprType(env: Environment): Type;
    evalExpr(env: Environment): Value {
        return new Value(this, checkExprType(this, env));
    }
}

// opaque values, used for passing in external arguments
class OpaqueThing extends Thing {
    constructor(public data: any) { super(); }
    toString() {return `opaque "${this.data?.toString()}"`;}
    // use the underlying native value's own equality function to compare
    isSameThing(b: Thing, _: Environment): boolean { return b instanceof OpaqueThing && this.data == b.data; }
    checkExprType(_: Environment): Type { return Symbol(); /* basically useless since it's Opaque */ }
}
// opaque type arguments. basically `OpaqueThing` but also a type
// these ones are never considered equal to each other, unless they are literally the same thing
class OpaqueType extends Thing implements IType {
    constructor(public name: symbol, public sort: UniverseType) { super(); }
    toString(): string { return this.name.description!; }
    formatType() { return this.toString(); }
    isSameThing(b: Thing, _: Environment): boolean { return b instanceof OpaqueType && b == this; }
    isSameType(b: Type, _: Environment): boolean { return b instanceof OpaqueType && b == this; }
    checkExprType(_: Environment): Type { return this.sort; }
}

// a name with its type
class Identifier {
    constructor(public name: symbol, public kind: Type) {}
    toString() {return `${this.name.description} : ${this.kind.toString()}`;}
}
// a value with its type
class Value {
    constructor(public data: Thing, public kind: Type) {}
    toString() {
        try {
            const env = this.data instanceof Func
                ? this.data.environment
                : new Environment();
            return `${this.data.toString()} : ${formatType(this.kind, env)}`;
        } catch(e) {
            return `${this.data.toString()} : ${this.kind.toString()}`;
        }
    }
}

// the symbol table holds the value of every variable
type SymTable = Record<symbol, Value>;
// an environment holding defined variables and arguments
class Environment {
    constructor(public parent?: Environment, public bindings: SymTable = {}) {}
    toString(): string {
        return "\n" + (Reflect.ownKeys(this.bindings) as symbol[])
            .map(x => `* "${x.description}" : ${this.bindings[x]?.toString()}`)
            .join("\n")
            + (this.parent ? "\n=============" + this.parent.toString() : "");
    }
    tryGet(name: symbol): Value | undefined {
        if(name in this.bindings) return this.bindings[name];
        else if(this.parent) return this.parent.tryGet(name);
        return undefined;
    }
    get(name: symbol): Value {
        if(this.tryGet(name)) return this.tryGet(name)!;
        throw new Error(`Couldn't find ${name.description} in environment`);
    }
    has(name: symbol): boolean {
        return name in this.bindings || this.parent?.has(name) || false;
    }
    and(name: symbol, value: Value) {
        return new Environment(this, {[name]: value});
    }
    all(): SymTable {
        const before: SymTable = this.parent?.all() || {};
        for(const item of Reflect.ownKeys(this.bindings) as symbol[]) before[item] = this.bindings[item]!;
        return before;
    }
    // combine two environments into one
    under(child: Environment) {
        return new Environment(this, child.all());
    }
}

// calling a function on arguments
class Call implements IExpr {
    constructor(public func: Expression, public argument: Expression) {}
    toString(): string {return `${this.func.toString()}(${this.argument.toString()})`;}
    checkExprType(env: Environment): Type {
        // first check the type of the thing we're calling...
        const vt = checkExprType(this.func, env);
        // ... and that it is a function
        if(!(vt instanceof FuncType)) {
            throw new Error(`${this.func.toString()} is not a function type, it is: ${vt.toString()}`);
        }
        // use the function's environment when checking the argument if it is a symbol
        const functionValue = typeof this.func == "symbol" ? env.get(this.func) : undefined;
        const env2 = functionValue?.data instanceof Func
            ? env.under(functionValue.data.environment)
            : env;
        // now check the type of the argument...
        const at = checkExprType(this.argument, env2);
        // ... and ensure the argument's type is correct
        //console.info(`${at.toString()} and ${vt.inType.toString()} in ${Reflect.ownKeys(env2.all()).map(x => x.toString()).join(", ")}`);
        if(!(accepts(at, vt.inType, env2))) {
            throw new Error(`Cannot call function ${this.func.toString()} of type ${vt.toString()} with argument ${this.argument.toString()} of type ${at.toString()}`);
        }
        // just give the return type
        return vt.outType;
    }
    evalExpr(env: Environment): Value {
        // first make sure that the thing we're calling is defined...
        const v = evalExpr(this.func, env);
        // ... and that it is a function
        if(!(v.data instanceof Func)) {
            throw new Error(`${this.func.toString()} is not a function, it is: ${v.toString()}`);
        }
        const f: Func = v.data;
        // now evaluate the argument...
        const a = evalExpr(this.argument, env);
        // add the function's own environment when checking whether the argument type is correct
        if(!(accepts(a.kind, f.argument.kind, env.under(f.environment)))) {
            // let's be nice and dereference the type for the user
            // so they know what they're looking for
            const expected = typeof f.argument.kind == "symbol"
                ? f.environment.tryGet(f.argument.kind)
                : undefined;
            const extraInfo = expected ? ` (${expected.data.toString()})` : "";
            throw new Error(`Expected an argument of type ${f.argument.kind.toString()}${extraInfo} for ${f.toString()}, but got ${a.toString()}`);
        }
        // add the argument to the function's environment
        // then evaluate it
        return evalExpr(f.definition, f.environment.and(f.argument.name, a));
    }
}
// defining a variable, allowing its identifier to be meaningful when evaluated later
// this cannot be used to define functions, use `FuncDefinition` instead.
// this is not an expression, instead it is a statement.
class VarDefinition implements IStmt {
    constructor(public name: symbol, public value: Expression) {}
    toString() {return `${this.name.description} = ${this.value.toString()}`;}
    checkStmtType(env: Environment): Environment {
        return env.and(this.name, new Value(new OpaqueThing(undefined), checkExprType(this.value, env)));
    }
    evalStmt(env: Environment): Environment {
        // define the variable and add it to the symbol table
        // throw an error if you try to reinstantiate an existing symbol
        // cause it's better for things to be const by default
        // especially important now that closures exist (because they would use the old value)
        if(env.has(this.name)) {
            throw new Error(`${this.name.description} is already defined`);
        }
        return env.and(this.name, evalExpr(this.value, env));
    }
}
// returns a value from a statement, allowing it to be used as an expression.
// this is the only way to have a statement return a value.
class Return implements IExpr {
    constructor(public stmts: Statement[], public returns: Expression) {}
    toString(): string {return `${this.stmts.map(x => x.toString()).join("; ")}; return ${this.returns.toString()}`;}
    checkExprType(env: Environment): Type {
        // evaluate the statements in the `Return` for their types
        const env2 = this.stmts.reduce((table, stmt) => checkStmtType(stmt, table), env);
        return checkExprType(this.returns, env2);
    }
    evalExpr(env: Environment): Value {
        const outTable = this.stmts.reduce((table, stmt) => evalStmt(stmt, table), env);
        return evalExpr(this.returns, outTable);
    }
}
// used to define functions
class FuncDefinition implements IStmt {
    constructor(public name: symbol, public argument: Identifier, public definition: Expression) {}
    toString() {return `fn ${this.name.description}(${this.argument.toString()}) { ${this.definition.toString()} }`;}
    checkStmtType(env: Environment): Environment {
        const lambda = new Lambda(this.argument, this.definition);
        return env.and(
            this.name,
            new Value(new OpaqueThing(undefined), lambda.checkExprType(env))
        );
    }
    evalStmt(env: Environment): Environment {
        // use a lambda to define a new function
        // then add it to the environment
        const value = new Lambda(this.argument, this.definition).evalExpr(env);
        return env.and(this.name, value);
    }
}
// an expression that creates an anonymouse function
// while capturing its context
class Lambda implements IExpr {
    constructor(public argument: Identifier, public definition: Expression) {}
    toString(): string { return `λ (${this.argument.toString()}) => ${this.definition.toString()}`; }
    checkExprType(env: Environment): Type {
        const argumentSort = resolveType(this.argument.kind, env);
        // choose an appropriate placeholder for the argument
        // based on whether it is a Type or a regular thing
        const placeholder = argumentSort instanceof UniverseType
            ? new OpaqueType(this.argument.name, argumentSort)
            : new OpaqueThing(undefined);
        const bodyEnvironment = env.and(this.argument.name, new Value(placeholder, this.argument.kind));
        return new FuncType(
            this.argument.kind,
            checkExprType(this.definition, bodyEnvironment)
        );
    }
    evalExpr(env: Environment): Value {
        const func = new Func(this.argument, this.definition, env);
        return new Value(func, this.checkExprType(env));
    }
}
// an anonymouse founction
class Func extends Thing {
    constructor(public argument: Identifier, public definition: Expression, public environment: Environment) { super(); }
    toString(): string {
        return `(${this.argument.name.description} : ${formatType(
            this.argument.kind,
            this.environment
        )}) => ${this.definition.toString()}`;
    }
    // functions aren't considered "the same"
    isSameThing(_b: Thing, _env: Environment): boolean { return false; }
    checkExprType(_env: Environment): Type {
        // check it in its own environment
        return new Lambda(this.argument, this.definition).checkExprType(this.environment);
    }
}
class FuncType implements IType {
    constructor(public inType: Type, public outType: Type) {}
    toString(): string {return `(${this.inType.toString()} => ${this.outType.toString()})`;}
    formatType(env: Environment, resolving: Set<symbol>) {
        return `(${formatType(this.inType, env, resolving)} => ${formatType(this.outType, env, resolving)})`;
    }
    isSameType(b: Type, env: Environment): boolean {
        return b instanceof FuncType && isSameType(this.inType, b.inType, env) && isSameType(this.outType, b.outType, env);
    }
}

// an expression that evaluates to a type
// this allows expressions to be converted to a type at runtime
// useful for types that take generics
class ComputedType implements IType {
    constructor(public expression: Expression) {}
    toString(): string { return this.expression.toString(); }
    formatType(env: Environment, resolving: Set<symbol>) { return formatType(resolveType(this, env), env, resolving); }
    isSameType(b: Type, env: Environment): boolean {
        return isSameType(resolveType(this, env), b, env);
    }
}

// match-expressions, the fundamental control flow pattern
class MatchCase {
    constructor(public lhs: Expression, public rhs: Expression) {}
    toString(): string {return `${this.lhs.toString()} -> ${this.rhs.toString()}`}
}
class Match implements IExpr {
    constructor(public variable: Expression, public cases: MatchCase[], public otherwise: Expression) {}
    toString(): string {return `match(${this.variable.toString()}) { ${[...this.cases, `else -> ${this.otherwise.toString()}`].map(x => x.toString()).join("; ")} }`;}
    checkExprType(env: Environment): Type {
        if(this.cases.length == 0) throw new Error("Match has no arms");
        // the type should be the type of all match arms
        const arm1 = checkExprType(this.cases[0]!.rhs, env);
        for(const arm of this.cases.slice(1)) {
            const at = checkExprType(arm.rhs, env);
            if(!(accepts(at, arm1, env))) throw new Error(`First match arm returns type ${arm1.toString()}, but another arm returns type ${at.toString()}`);
        }
        // check the default case too
        const defaultCase = checkExprType(this.otherwise, env);
        if(!(accepts(defaultCase, arm1, env))) {
            throw new Error(`First match arm returns type ${arm1.toString()}, but default case returns type ${defaultCase.toString()}`);
        }
        return arm1;
    }
    evalExpr(env: Environment): Value {
        const v = evalExpr(this.variable, env);
        // call the appropriate expression
        for(const c of this.cases) {
            const lhs = evalExpr(c.lhs, env);
            if(isSameValue(v, lhs, env)) return evalExpr(c.rhs, env);
        }
        return evalExpr(this.otherwise, env);
    }
}

// objects are a very useful type, because they allow "more types" to be created.
// objects hold a collection of named and typed values
// `ObjClass` is like `Func`, and `ObjFactory` is like `Lambda`.
// the type of every `ObjClass` is a special type: `UniverseType`.
class ObjFactory implements IExpr {
    constructor(public constructors: Record<symbol, Identifier[]>, private debugName: string = "", private debugFields: Expression[] = []) {}
    toString(): string {
        if(this.debugName) {
            const parameters = this.debugFields.length
                ? `<${this.debugFields.map(field => field.toString()).join(", ")}>`
                : "";
            return `class ${this.debugName}${parameters}`;
        } else {
            // you should never be printing out a class verbosely like this
            // it's ugly and bad.
            // but you *can*, I guess.
            return `class { ${Reflect.ownKeys(this.constructors).map(
                key => `${key.toString()} (${this.constructors[key as symbol]!.join(", ")})`
            ).join(", ")} }`;
        }
    }
    checkExprType(_: Environment): Type {
        return new UniverseType(); // the type of any class is Type
    }
    evalExpr(env: Environment): Value {
        // use the factory to generate a class that captures its environment
        const runtimeClass = new ObjClass(
            this.constructors, env,
            this.debugName, this.debugFields // ...and the debug info too
        );
        return new Value(runtimeClass, new UniverseType());
    }
}
// a class with a fixed environment
class ObjClass extends Thing implements IType {
    // each item in `constructors` is one way to construct this object
    constructor(public constructors: Record<symbol, Identifier[]>, public myEnv: Environment, private debugName: string = "", private debugFields: Expression[] = []) { super(); }
    toString() {
        const reFields: Record<symbol, Identifier[]> = {};
        for(const key of Reflect.ownKeys(this.constructors)) {
            const ids = this.constructors[key as symbol]!;
            reFields[key as symbol] = ids.map(id => new Identifier(
                id.name,
                (typeof id.kind == "symbol" && this.myEnv.has(id.kind)) ? asType(this.myEnv.get(id.kind).data) : id.kind
            ));
        }
        return "class " + (this.debugName ? `${this.debugName}${this.debugFields.length ? `<${this.debugFields.map(x => evalExpr(x, this.myEnv).data.toString().replace("class ", "")).join(", ")}>` : ""}` : `{ ${Reflect.ownKeys(reFields).map(x => `${x.toString()} (${reFields[x as symbol]!.join(", ")})`).join(", ")} }`);
    }
    formatType() { return this.toString(); }
    isSameThing(b: Thing, env: Environment): boolean {
        // like `Func`s, these are not considered to be equal.
        return b instanceof ObjClass && this.isSameType(b, env);
    }
    checkExprType(_: Environment): Type {
        return new UniverseType(); // the type of any class is Type
    }
    isSameType(b: Type, env: Environment): boolean {
        if(!(b instanceof ObjClass)) return false;
        const k1 = Reflect.ownKeys(this.constructors) as symbol[], k2 = Reflect.ownKeys(b.constructors) as symbol[];
        return k1.length == k2.length && k1.every(
            cons => k2.includes(cons) &&
            this.constructors[cons]!.length == b.constructors[cons]!.length &&
            this.constructors[cons]!.every(
                (id, i) => id.name == b.constructors[cons]![i]!.name && isSameType(id.kind, b.constructors[cons]![i]!.kind, env)
            )
        );
    }
    instantiateCapturedType(type: Type, resolving = new Set<symbol>()): Type {
        if(typeof type == "symbol") {
            if(resolving.has(type)) return type;
            const captured = this.myEnv.tryGet(type);
            if(captured && isType(captured.data)) {
                const nextResolving = new Set(resolving);
                nextResolving.add(type);
                return this.instantiateCapturedType(captured.data, nextResolving);
            }
            return type;
        }
        if(type instanceof FuncType) {
            return new FuncType(
                this.instantiateCapturedType(type.inType, resolving),
                this.instantiateCapturedType(type.outType, resolving)
            );
        }
        if(type instanceof ComputedType) {
            return this.instantiateCapturedType(resolveType(type, this.myEnv), resolving);
        }
        return type;
    }
}

// special extension of `ObjClass` for certain unique things that can't be constructed
class NonconstructibleObjClass extends ObjClass {
    constructor(private secretKey: symbol) { super({}, new Environment(), secretKey.description); }
    isSameType(b: Type, _: Environment): boolean {
        return b instanceof NonconstructibleObjClass && this.secretKey == b.secretKey;
    }
}
// special class for the Any type.
const Any = new NonconstructibleObjClass(Symbol.for("Any"));
// special class for the Type type.
class UniverseType extends NonconstructibleObjClass {
    constructor(public universeLevel: number = 0) {
        super(Symbol.for(universeLevel == 0 ? "Type" : "Type " + universeLevel));
    }
    checkExprType(_: Environment): Type {
        return new UniverseType(this.universeLevel + 1);
    }
    evalExpr(_: Environment) {
        return new Value(this, new UniverseType(this.universeLevel + 1));
    }  
}
// constructs a new object
class Construct implements IExpr {
    constructor(public toaster: Expression, public cons: symbol, public fields: Record<symbol, Expression>) {}
    toString(): string {return `${this.toaster.toString()}.${this.cons.description}(${Reflect.ownKeys(this.fields).map(x => `${x.toString()} = ${this.fields[x as symbol]!.toString()}`).join(", ")})`;}
    checkExprType(env: Environment): Type {
        return checkExprType(this.toaster, env);
    }
    evalExpr(env: Environment): Value {
        // construct an object
        // the actual fields of the object will be checked in the `Thing` branch of this function
        // so no need to do the work twice
        const cons = evalExpr(this.toaster, env);
        if(!(cons.data instanceof ObjClass)) {
            throw new Error(`${this.toaster.toString()} is not a class, it is: ${cons.toString()}`);
        }
        // evaluate each field
        // also, take into account the object's closure table if it has one
        const fullTable = env.under(cons.data.myEnv);
        const computedFields: Record<symbol, Value> = {};
        for(const key of Reflect.ownKeys(this.fields)) {
            computedFields[key as symbol] = evalExpr(this.fields[key as symbol]!, fullTable);
        }
        return evalExpr(new Obj(cons.data, this.cons, computedFields), fullTable);
    }
}
// a constructed object
// there is no way to stop someone from constructing one of these with mismatched fields
// so in `evalExpr` we just have to make sure they're sound before they get actually used
class Obj extends Thing {
    constructor(public toaster: ObjClass, public cons: symbol, public fields: Record<symbol, Value>) { super(); }
    toString() {
        if(Reflect.ownKeys(this.fields).length == 0) return `object ${this.cons.description}`;
        else return `object ${this.cons.description} { ${Reflect.ownKeys(this.fields).map(x => `${x.toString()} (${this.fields[x as symbol]!})`).join(", ")} }`;
    }
    isSameThing(b: Thing, env: Environment): boolean {
        // objects are equal if all their fields are equal
        // and they were constructed from the same constructor symbol
        // technically this can sometimes falsely return true if multiple classes all have the same
        // data for whatever reason but at that point there is no way to tell them apart
        // so... just don't reuse the exact same symbols for multiple classes
        // pona anu seme?
        return b instanceof Obj &&
        this.cons == b.cons &&
        Reflect.ownKeys(this.fields).length == Reflect.ownKeys(b.fields).length &&
        Reflect.ownKeys(this.fields).every(f => f in b.fields && isSameThing(this.fields[f as symbol]!.data, b.fields[f as symbol]!.data, env));
    }
    checkExprType(_: Environment): Type {
        return this.toaster;
    }
    evalExpr(env: Environment): Value {
        // if the value is an object, this is a good time to check it and make sure
        // that its properties match what is expected
        // first check the constructor
        if(!(this.cons in this.toaster.constructors)) {
            throw new Error(`${this.cons.description} is not a constructor for ${this.toaster.toString()}`);
        }
        // then check the properties
        // it should have all of the properties it claims to have
        // and should not have any properties it does not need
        const constructors = this.toaster.constructors[this.cons]!;
        const keys = Reflect.ownKeys(this.fields);
        if(constructors.length != keys.length) {
            throw new Error(`Wrong number of fields (provided ${keys.length}, wanted ${constructors.length})`);
        }
        const missing = constructors.find(key => !(keys.includes(key.name)));
        if(missing) {
            throw new Error(`Object is missing a property: ${missing.name.description}`);
        }
        // finally, make sure that the types of all properties are correct
        const wrong = constructors.find(key => !(accepts(this.fields[key.name]!.kind, this.toaster.instantiateCapturedType(key.kind), env)));
        if(wrong) {
            // when throwing an error in this way, try to use the symbol table to change the argument type
            const expected = typeof wrong.kind == "symbol" ? env.tryGet(wrong.kind) : undefined;
            if(expected) {
                throw new Error(`Field is the wrong type (provided ${this.fields[wrong.name]?.toString()}, wanted ${wrong.kind.toString()} (${expected.toString()}))`);
            } else {
                // if it didn't work, that's ok too.
                throw new Error(`Field is the wrong type (provided ${this.fields[wrong.name]?.toString()}, wanted ${wrong.kind.toString()})`);
            }
        }
        return super.evalExpr(env);
    }
}
// get a field of an object
class PropertyAccess implements IExpr {
    constructor(public obj: Expression, public field: symbol) {}
    toString(): string {return `${this.obj.toString()}.${this.field.description}`};
    checkExprType(env: Environment): Type {
        const receiver = typeof this.obj == "symbol" ? env.tryGet(this.obj) : undefined;
        if(receiver?.data instanceof Obj) {
            const field = receiver.data.fields[this.field];
            if(field == undefined) {
                throw new Error(`${receiver.toString()} does not have a field named ${this.field.description}`);
            }
            return field.kind;
        }
        // otherwise, inspect the receiver's declared type
        const receiverType = checkExprType(this.obj, env);
        const toaster = resolveType(receiverType, env);
        if(!(toaster instanceof ObjClass)) {
            throw new Error(`${this.obj.toString()} is not an object, it is: ${receiverType.toString()}`);
        }
        // find every constructor field with this name
        const matchingFields = (Reflect.ownKeys(toaster.constructors) as symbol[])
            .flatMap(cons => toaster.constructors[cons]!)
            .filter(field => field.name == this.field);
        // ...and error if there are none
        if(matchingFields.length == 0) {
            throw new Error(`No constructor of ${toaster.toString()} defines a field named ${this.field.description}`);
        }
        // resolve the field's type using the class's captured environment
        const fieldTypes = matchingFields.map(field => toaster.instantiateCapturedType(field.kind));
        // a field appearing in multiple constructors must have the same
        // type in every constructor, unless the receiver was already refined.
        // otherwise, it's too difficult to know what the resultant type should be.
        const fieldType = fieldTypes[0]!;
        if(!fieldTypes.every(type => isSameType(type, fieldType, env))) {
            throw new Error(`Cannot determine the type of ${this.field.description}: it has different types in different constructors`);
        }
        return fieldType;
    }
    evalExpr(env: Environment): Value {
        const obj = evalExpr(this.obj, env);
        if(!(obj.data instanceof Obj)) {
            throw new Error(`${this.obj.toString()} is not an object, it is: ${obj.toString()}`);
        }
        if(!(this.field in obj.data.fields)) {
            throw new Error(`That object does not have a field named ${this.field.description}`);
        }
        return obj.data.fields[this.field]!;
    }
}
// objects have a special kind of matching that works on their constructors
// in Lean this is a normal match expression but I'm making it a different thing for convenience
class Pattern implements IExpr {
    constructor(public variable: Expression, public cases: Record<symbol, Expression>) {}
    toString(): string {return `match(${this.variable.toString()}) { ${Reflect.ownKeys(this.cases).map(x => `${x.toString()} -> ${this.cases[x as symbol]!.toString()}`).join("; ")} }`;}
    checkExprType(env: Environment): Type {
        const keys = Reflect.ownKeys(this.cases) as symbol[];
        if(keys.length == 0) throw new Error("Pattern has no cases");

        // resolve the matched value to determine which class it is
        const variableType = checkExprType(this.variable, env);
        const toaster = resolveType(variableType, env);
        if(!(toaster instanceof ObjClass)) {
            throw new Error(`Cannot pattern-match ${this.variable.toString()} because its type is not an object class`);
        }

        const constructors = Reflect.ownKeys(toaster.constructors) as symbol[];
        if(constructors.length != keys.length) {
            throw new Error(`Wrong number of cases in pattern (provided ${keys.length}, wanted ${constructors.length})`);
        }
        const missing = constructors.find(key => !keys.includes(key));
        if(missing) throw new Error(`Pattern is missing a case: ${missing.description}`);

        // once the constructor is known, construct a synthetic version of it
        let armType: Type | undefined;
        for(const cons of keys) {
            const extras: SymTable = {};
            if(typeof this.variable == "symbol") {
                const fields: Record<symbol, Value> = {};
                for(const field of toaster.constructors[cons]!) {
                    // resolve fields
                    const fieldType = toaster.instantiateCapturedType(field.kind);
                    fields[field.name] = new Value(new OpaqueThing(undefined), fieldType);
                }
                extras[this.variable] = new Value(new Obj(toaster, cons, fields), variableType);
            }
            const env2 = new Environment(env, {...extras});

            const currentType = checkExprType(this.cases[cons]!, env2);
            if(armType == undefined) { armType = currentType; }
            else if(!accepts(currentType, armType, env2)) {
                throw new Error(`First pattern returns type ${armType.toString()}, but another arm returns type ${currentType.toString()}`);
            }
        }
        return armType!;
    }
    evalExpr(env: Environment) {
        // this is a familiar pattern by now
        const obj = evalExpr(this.variable, env);
        if(!(obj.data instanceof Obj)) {
            throw new Error(`${this.variable.toString()} is not an object, it is: ${obj.toString()}`);
        }
        // first, ensure all cases are handled
        const setP = Reflect.ownKeys(obj.data.toaster.constructors) as symbol[];
        const setO = Reflect.ownKeys(this.cases);
        if(setP.length != setO.length) {
            throw new Error(`Wrong number of cases in pattern (provided ${setO.length}, wanted ${setP.length})`);
        }
        const missing = setP.find(key => !(setO.includes(key)));
        if(missing) {
            throw new Error(`Pattern is missing a case: ${missing.description}`);
        }
        return evalExpr(this.cases[obj.data.cons]!, env);
    }
}

// get the constructor that was used to construct an object
// todo
// get the toaster of an object
class Toaster implements IExpr {
    constructor(public obj: Expression) {}
    toString() {return `${this.obj.toString()}.toaster`;}
    checkExprType(env: Environment) {
        const obj = evalExpr(this.obj, env);
        const k = obj.kind;
        if(!(k instanceof Thing)) {
            throw new Error(`Can't get the toaster of ${obj.toString()} because it's not an object`);
        }
        return checkExprType(k, env);
    }
    evalExpr(env: Environment) {
        const obj = evalExpr(this.obj, env);
        const k = obj.kind;
        if(!(k instanceof Thing)) {
            throw new Error(`Can't get the toaster of ${obj.toString()} because it's not an object`);
        }
        return new Value(k, checkExprType(k, env));
    }
}

// propositions!!!! finally we're getting to the "proving" part of the program
const TProp = new NonconstructibleObjClass(Symbol.for("TProp"));
abstract class Proposition extends NonconstructibleObjClass implements IType {
    constructor() { super(Symbol.for("Prop")); }
    // isSameType(b: Type, symTable: SymTable): boolean;
    abstract isSameType(b: Type, env: Environment): boolean;
    isSameThing(b: Thing, env: Environment) {
        // once again, `isSameThing` is equal to `isSameType` if the latter exists
        return b instanceof Proposition && this.isSameType(b, env);
    }
    checkExprType(_: Environment) {
        return TProp; // the type of any proposition is "Prop"
    }
}
class OpaqueProp extends Proposition {
    constructor(public data: any) { super(); }
    toString() {return `proposition "${this.data.toString()}"`;}
    // check the underlying data using its own equality function
    isSameType(b: Type, _: Environment): boolean { return b instanceof OpaqueProp && this.data == b.data; }
}

// utility function for printing types
function formatType(type: Type, env: Environment, resolving = new Set<symbol>()): string {
    if(typeof type == "symbol") {
        if(resolving.has(type)) return type.description!;
        const value = env.tryGet(type);
        if(!value || !isType(value.data)) return type.description!;
        const next = new Set(resolving);
        next.add(type);
        return formatType(value.data, env, next);
    } else {
        return type.formatType(env, resolving);
    }
}

// dereference and evaluate computed types
function resolveType(type: Type, env: Environment) {
    // symbols get dereferenced
    if(typeof type == "symbol") return asType(env.get(type).data);
    // computed types get evaluated
    if(type instanceof ComputedType) return asType(evalExpr(type.expression, env).data);
    return type;
}
// utility function for checking whether types match
// this results in infinite loops sometimes so as a stopgap measure I'm adding a hard limit on iter count
function isSameType(at: Type, bt: Type, env: Environment, iters = 0): boolean {
    if(iters >= 10) {
        console.warn("Evaluated too deep while checking types");
        return false;
    }
    // if they are the same object, just return true
    if(at == bt) return true;
    // resolve types to their underlying values
    if(typeof at == "symbol" && typeof bt == "symbol" && at == bt) return true;
    const a = resolveType(at, env);
    const b = resolveType(bt, env);
    // compare, dereferencing recursively if necessary
    return (a == at && b == bt) ? a.isSameType(b, env) : isSameType(a, b, env, iters + 1);
}
function accepts(arg: Type, target: Type, env: Environment) {
    //console.info(`checking ${arg.toString()} and ${target.toString()} in ${Reflect.ownKeys(env.all()).map(x => x.toString()).join(", ")}`);
    return isSameType(arg, target, env) || isSameType(target, Any, env) || isSameType(arg, Any, env); // for the future
}
// function for checking whether values match
function isSameThing(a: Thing, b: Thing, env: Environment): boolean {
    return a.isSameThing(b, env);
}
// this is a kind of "equality", but it's really more like "exactly the same"
// it is conservative, returning false if the arguments aren't really exactly the same
function isSameValue(a: Value, b: Value, env: Environment) {
    return isSameType(a.kind, b.kind, env) && isSameThing(a.data, b.data, env);
}

// try to evaluate a statement, but only for its type
function checkStmtType(code: Statement, env: Environment): Environment {
    //console.info(`Type-checking '${code.toString()}' using symbols: ${Reflect.ownKeys(symTable).map(x => typeof x == "string" ? x : x.description).join(", ")}`);
    return code.checkStmtType(env);
}
// try to evaluate a statement, and return the new symbol table after evaluating
function evalStmt(code: Statement, env: Environment): Environment {
    //console.info(`Executing '${code.toString()}' using symbols: ${Reflect.ownKeys(symTable).map(x => typeof x == "string" ? x : x.description).join(", ")}`);
    return code.evalStmt(env);
}
const evalStmts = (code: Statement[], env: Environment) => code.reduce((table, stmt) => evalStmt(stmt, table), env);
// try to evaluate an expression, and return its type
function checkExprType(code: Expression, env: Environment): Type {
    //console.info(`Type-checking '${code.toString()}' using symbols: ${Reflect.ownKeys(symTable).map(x => typeof x == "string" ? x : x.description).join(", ")}`);
    if(typeof code == "symbol") {
        return env.get(code).kind;
    } else {
        return code.checkExprType(env);
    }
}
// try to evaluate an expression, and return its value
function evalExpr(code: Expression, env: Environment): Value {
    //console.info(`Evaluating '${code.toString()}' using symbols: ${Reflect.ownKeys(symTable).map(x => x.toString()).join(", ")}`);
    // do something based on what kind of expression it is
    if(typeof code == "symbol") {
        return env.get(code);
    } else {
        return code.evalExpr(env);
    }
}

// boolean operations
const _Bool = Symbol("Bool"), _true = Symbol("true"), _false = Symbol("false");
const _x = Symbol("x"), _y = Symbol("y");
const _id = Symbol("id"), _not = Symbol("not"), _and = Symbol("and"), _or = Symbol("or");
const _const = Symbol("const"), _andMeta = Symbol("andMeta"), _andClosure = Symbol("andClosure"), _orMeta = Symbol("orMeta"), _orClosure = Symbol("orClosure");
const booleanOps = [
    new VarDefinition(_Bool, new ObjFactory({
        [_false]: [],
        [_true]: []
    }, "Bool")),
    new VarDefinition(_false, new Construct(_Bool, _false, {})),
    new VarDefinition(_true, new Construct(_Bool, _true, {})),
    new FuncDefinition(_id, new Identifier(_x, _Bool), _x),
    new FuncDefinition(_const, new Identifier(_x, _Bool), new Lambda(new Identifier(_y, _Bool), _x)),
    new FuncDefinition(_not, new Identifier(_x, _Bool), new Match(
        _x, [new MatchCase(_true, _false)], _true
    )),
    new FuncDefinition(_and, new Identifier(_x, _Bool), new Match(
        _x, [new MatchCase(_true, _id)], new Lambda(new Identifier(_y, _Bool), _false)
    )),
    new FuncDefinition(_andMeta, new Identifier(_x, _Bool), new Match(
        _x, [new MatchCase(_true, _id)], new Call(_const, _false)
    )),
    new FuncDefinition(_andClosure, new Identifier(_x, _Bool), new Lambda(new Identifier(_y, _Bool), new Match(
        _x, [new MatchCase(_true, _y)], _false
    ))),
    new FuncDefinition(_or, new Identifier(_x, _Bool), new Match(
        _x, [new MatchCase(_false, _id)], new Lambda(new Identifier(_y, _Bool), _true)
    )),
    new FuncDefinition(_orMeta, new Identifier(_x, _Bool), new Match(
        _x, [new MatchCase(_false, _id)], new Call(_const, _true)
    )),
    new FuncDefinition(_orClosure, new Identifier(_x, _Bool), new Lambda(new Identifier(_y, _Bool), new Match(
        _x, [new MatchCase(_false, _y)], _true
    )))
];
const boolTable = evalStmts(booleanOps, new Environment());
console.log(evalExpr(new Call(new Call(_orMeta, _true), _false), boolTable).toString());

// object testing
const _Nat = Symbol("Nat"), _zero = Symbol("zero"), _succ = Symbol("succ"), _prev = Symbol("prev");
const _0 = Symbol("0"), _anotherZero = Symbol("anotherZero"), _1 = Symbol("1"), _2 = Symbol("2");
const _is0 = Symbol("is0"), _anotherIs0 = Symbol("anotherIs0"), _num = Symbol("num");
const natNumbers = [
    new VarDefinition(_Nat, new ObjFactory({
        [_zero]: [],
        [_succ]: [new Identifier(_prev, _Nat)]
    }, "Nat")),
    new VarDefinition(_0, new Construct(_Nat, _zero, {})),
    new VarDefinition(_anotherZero, new Construct(_Nat, _zero, {})),
    new VarDefinition(_1, new Construct(_Nat, _succ, {[_prev]: _0})),
    new VarDefinition(_2, new Construct(_Nat, _succ, {[_prev]: _1})),
    new FuncDefinition(_is0, new Identifier(_num, _Nat), new Match(_num, [
        new MatchCase(_0, _true)
    ], _false)),
    new FuncDefinition(_anotherIs0, new Identifier(_num, _Nat), new Pattern(_num, {
        [_zero]: _true,
        [_succ]: _false
    }))
];

const natTable = evalStmts(natNumbers, boolTable);
function makeNat(from: number): Value {
    const num = Math.abs(Math.floor(from)); // make it a nonnegative integer if it isn't already
    if(num == 0) return evalExpr(_0, natTable);
    else return evalExpr(new Construct(_Nat, _succ, {[_prev]: makeNat(num - 1).data}), natTable);
}
function parseNat(code: Expression, env: Environment): number {
    const value = evalExpr(code, env).data as Obj;
    if(value.cons == _zero) return 0;
    else return 1 + parseNat(value.fields[_prev]!.data, env);
}
console.log(parseNat(makeNat(10).data, natTable).toString());

console.log(evalExpr(new Call(_is0, _anotherZero), natTable).toString());
console.log(evalExpr(new Call(_anotherIs0, _1), natTable).toString());
console.log(evalExpr(new Construct(_Nat, _succ, {[_prev]: new PropertyAccess(_2, _prev)}), natTable).toString());

// advanced object testing
const _Or = Symbol("Or"), _Or1 = Symbol("Or1"), _Or2 = Symbol("Or2"), _OrL = Symbol("OrL"), _OrR = Symbol("OrR"), _value = Symbol("value");
const orClass = new FuncDefinition(_Or, new Identifier(_Or1, new UniverseType()), new Lambda(
    new Identifier(_Or2, new UniverseType()),
    new ObjFactory({
        [_OrL]: [new Identifier(_value, _Or1)],
        [_OrR]: [new Identifier(_value, _Or2)]
    }, "Or", [_Or1, _Or2])
));
const orTable = evalStmts([orClass], new Environment());
console.log(evalExpr(
    new Construct(new Call(new Call(_Or, _Bool), _Nat), _OrL, {[_value]: _true}),
    natTable.under(orTable)
).toString());
const _And = Symbol("And"), _And1 = Symbol("And1"), _And2 = Symbol("And2"), _fst = Symbol("fst"), _snd = Symbol("snd");
const andClass = new FuncDefinition(_And, new Identifier(_And1, new UniverseType()), new Lambda(
    new Identifier(_And2, new UniverseType()),
    new ObjFactory({
        [_And]: [new Identifier(_fst, _And1), new Identifier(_snd, _And2)],
    }, "And", [_And1, _And2])
));
const andTable = evalStmts([andClass], new Environment());
console.log(evalExpr(
    new Construct(new Call(new Call(_And, _Bool), _Nat), _And, {[_fst]: _true, [_snd]: _1}),
    natTable.under(andTable)
).toString());

// toaster testing
const _andAuto = Symbol("andAuto"), _a1 = Symbol("a1"), _a2 = Symbol("a2"), _orAutoL = Symbol("orAutoL"), _o1 = Symbol("o1"), _o2 = Symbol("o2");
console.log(evalExpr(
    new Return([
        new FuncDefinition(_orAutoL, new Identifier(_o1, Any), new Lambda(
            new Identifier(_o2, new UniverseType()),
            new Construct(new Call(new Call(_Or, new Toaster(_o1)), _o2), _OrL, {[_value]: _o1})
        ))
    ], new Call(new Call(_orAutoL, _0), _Bool)),
    natTable.under(orTable)
).toString());
console.log(evalExpr(
    new Return([
        new FuncDefinition(_andAuto, new Identifier(_a1, Any), new Lambda(
            new Identifier(_a2, Any),
            new Construct(new Call(new Call(_And, new Toaster(_a1)), new Toaster(_a2)), _And, {[_fst]: _a1, [_snd]: _a2})
        ))
    ], new Call(new Call(_andAuto, _0), _false)),
    natTable.under(andTable)
).toString());

// functions can take `And`s and `Or`s
const _Or_elim = Symbol("Or_elim"), _Oe1 = Symbol("oe1"), _Oe2 = Symbol("oe2"), _orX = Symbol("X"), _Target = Symbol("Target"), _imp1 = Symbol("imp1"), _imp2 = Symbol("imp2");
const orElim = evalStmt(
    new FuncDefinition(_Or_elim, new Identifier(_Oe1, new UniverseType()), new Lambda(
        new Identifier(_Oe2, new UniverseType()), new Lambda(
            new Identifier(_Target, new UniverseType()), new Lambda(
                new Identifier(_orX, new ComputedType(new Call(new Call(_Or, _Oe1), _Oe2))), new Lambda(
                    new Identifier(_imp1, new FuncType(_Oe1, _Target)), new Lambda(
                        new Identifier(_imp2, new FuncType(_Oe2, _Target)), new Pattern(
                            _orX, {
                                [_OrL]: new Call(_imp1, new PropertyAccess(_orX, _value)),
                                [_OrR]: new Call(_imp2, new PropertyAccess(_orX, _value))
                            }
                        )
                    )
                )
            )
        )
    )), 
    boolTable.under(natTable.under(orTable))
);
const orElim1 = evalExpr(new Call(_Or_elim, _Bool), orElim); console.log(orElim1.toString());
const orElim2 = evalExpr(new Call(orElim1.data, _Nat), orElim); console.log(orElim2.toString());
const orElim3 = evalExpr(new Call(orElim2.data, _Nat), orElim); console.log(orElim3.toString());
const orElimC = evalExpr(new Construct(new Call(new Call(_Or, _Bool), _Nat), _OrR, {[_value]: _0}), orElim); console.log(orElimC.toString());
const orElim4 = evalExpr(new Call(orElim3.data, orElimC.data), orElim); console.log(orElim4.toString());
const orElim5 = evalExpr(new Call(orElim4.data, new Lambda(new Identifier(_x, _Bool), _0)), orElim); console.log(orElim5.toString());
const orElim6 = evalExpr(new Call(orElim5.data, new Lambda(new Identifier(_x, _Nat), _1)), orElim); console.log(orElim6.toString());
// yay!! it finally works!!

// proposition testing
const _And_elimL = Symbol("And_elimL"), _Ae1 = Symbol("Ae1"), _Ae2 = Symbol("Ae2");
const andElimL = evalStmt(
    new FuncDefinition(_And_elimL, new Identifier(_Ae1, new UniverseType()), new Lambda(
        new Identifier(_Ae2, new UniverseType()), new Lambda(
            new Identifier(_and, new ComputedType(new Call(new Call(_And, _Ae1), _Ae2))),
            new PropertyAccess(_and, _fst)
        )
    )),
    andTable
);
console.log(andElimL.toString());
